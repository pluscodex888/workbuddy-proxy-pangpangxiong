import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, check, identifier, noCallerIdentity, ownerKey, digest, terminal, textBlocks, limitsDefault, redact } from './contracts.mjs';
import { assertNativeMode } from './provider-raw-adapter.mjs';
import { planHistory, importHistory } from './history-adapter.mjs';
import { normalizeEvent, outcome } from './events.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fingerprint } = require('./fingerprint.cjs');

export class SessionService {
  constructor(adapter, journal, { limits = {}, allowedWorkspaces = [], logStore = null, allowBypassPermissions = true } = {}) {
    this.adapter = adapter; this.journal = journal; this.limits = { ...limitsDefault, ...limits };
    // An explicit historical inputBytes setting remains a cap for every route
    // unless an administrator separately configures rawInputBytes.
    if(Object.hasOwn(limits,'inputBytes')&&!Object.hasOwn(limits,'rawInputBytes'))this.limits.rawInputBytes=limits.inputBytes;
    for (const k of ['globalConcurrency', 'inputBytes', 'rawInputBytes', 'journalBytes', 'eventPage']) check(Number.isSafeInteger(this.limits[k]) && this.limits[k] > 0, 'invalid_limits');
    this.allowedWorkspaces = allowedWorkspaces.map(p => path.resolve(p)); this.logStore = logStore;
    this.allowBypassPermissions = allowBypassPermissions;
    this.active = new Map(); this.pendingCreates = new Map(); this.deliveryFailures = new Map(); this.closed = false;
  }
  log(input) {
    if (!this.logStore) return;
    const operation = input.operation ?? 'session:sendMessage';
    this.logStore.record({ ...input, operation, taskId: input.taskId ?? input.turnId, phase: input.phase ?? input.status });
  }
  capabilities() { return { schema: 'workbaby.capabilities/v1', ...this.adapter.capabilities(), identity: this.adapter.currentIdentity(), limits: this.limits }; }
  workspace(cwd) {
    check(typeof cwd === 'string' && path.isAbsolute(cwd), 'absolute_workspace_required');
    const resolved = path.resolve(cwd);
    check(this.allowedWorkspaces.includes(resolved), 'workspace_not_configured', 403);
    return resolved;
  }
  async createSession(body) {
    check(!this.closed, 'service_closing', 503); noCallerIdentity(body);
    assertNativeMode(body.executionMode);
    const who = this.adapter.currentIdentity(), externalSessionId = identifier(body.externalSessionId, 'external_session_id');
    const config = { cwd: this.workspace(body.cwd), permissionMode: body.permissionMode, ...(body.model ? { model: identifier(body.model, 'model') } : {}) };
    check(['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(config.permissionMode), 'explicit_permission_mode_required');
    check(this.allowBypassPermissions || config.permissionMode !== 'bypassPermissions', 'permission_mode_not_allowed', 403);
    const key = digest([ownerKey(who), externalSessionId, body.executionMode]), configDigest = digest(config);
    if (this.pendingCreates.has(key)) {
      check(this.pendingCreates.get(key).digest === configDigest, 'session_configuration_conflict', 409);
      return this.pendingCreates.get(key).promise;
    }
    const old = [...this.journal.sessions.values()].find(s => s.key === key);
    if (old) {
      check(old.configDigest === configDigest, 'session_configuration_conflict', 409);
      check(old.state === 'ready', 'session_creation_in_doubt', 409);
      await this.adapter.load(old.nativeSessionId, old.cwd, who, config);
      const receipt = this.sessionReceipt(old);
      this.log({ direction: 'response', externalSessionId, operation: 'session:create', phase: 'reused', status: 'session_reused', result: 'ready', detail: 'native session loaded' });
      return receipt;
    }
    const session = { id: randomUUID(), key, owner: who, externalSessionId, executionMode: body.executionMode, configDigest, ...config, state: 'creating', historyRevision: 0, historySource: [] };
    this.journal.commit({ session });
    const promise = (async () => {
      try {
        session.nativeSessionId = await this.adapter.create(config, who);
        session.state = 'ready'; this.journal.commit({ session }); return this.sessionReceipt(session);
      } catch (e) {
        session.state = 'in_doubt';
        try { this.journal.commit({ session }); } catch { /* writer remains failed closed */ }
        throw e;
      }
    })();
    this.pendingCreates.set(key, { promise, digest: configDigest });
    try {
      const receipt = await promise;
      this.log({ direction: 'response', externalSessionId, operation: 'session:create', phase: 'completed', status: 'session_created', result: 'ready', detail: 'native session ready' });
      return receipt;
    } catch (e) {
      this.log({ direction: 'error', externalSessionId, operation: 'session:create', phase: 'failed', status: e?.code ?? 'session_create_failed', result: 'failed', detail: 'native session creation failed' });
      throw e;
    } finally { this.pendingCreates.delete(key); }
  }
  sessionReceipt(s) { return { sessionId: s.id, nativeSessionId: s.nativeSessionId, externalSessionId: s.externalSessionId, executionMode: s.executionMode, historyRevision: s.historyRevision }; }
  session(id) {
    const s = this.journal.session(id);
    check(s && ownerKey(s.owner) === ownerKey(this.adapter.currentIdentity()), 'session_not_found', 404);
    check(s.state === 'ready', 'session_not_ready'); return s;
  }
  turn(id) {
    const turn = this.journal.turn(id);
    check(turn && ownerKey(turn.owner) === ownerKey(this.adapter.currentIdentity()), 'turn_not_found', 404);
    const failure = this.deliveryFailures.get(id);
    return failure ? { ...turn, state: 'in_doubt', deliveryState: 'failed', reason: failure } : turn;
  }
  status(id) {
    const t = this.turn(id);
    return { turnId: t.id, sessionId: t.sessionId, nativeSessionId: t.nativeSessionId, requestId: t.requestId,
      providerRequestId: t.providerRequestId ?? null, state: t.state, deliveryState: t.deliveryState,
      committedSeq: t.seq, reason: t.reason ?? t.recoveryReason ?? null, stopReason: t.stopReason ?? null,
      cancelRequested: t.cancelRequested === true, createdAt: t.createdAt, updatedAt: t.updatedAt };
  }
  receipt(t) { return { accepted: true, turnId: t.id, sessionId: t.sessionId, nativeSessionId: t.nativeSessionId, requestId: t.requestId }; }
  async submit(sessionId, body) {
    check(!this.closed, 'service_closing', 503); noCallerIdentity(body);
    check(body.schema === 'workbaby.session-turn/v1', 'invalid_schema');
    assertNativeMode(body.executionMode);
    check(Buffer.byteLength(JSON.stringify(body)) <= this.limits.inputBytes, 'input_too_large', 413);
    const session = this.session(sessionId), who = this.adapter.currentIdentity();
    check(body.externalSessionId === session.externalSessionId, 'external_session_mismatch');
    const requestId = identifier(body.requestId, 'request_id'), requestDigest = digest(body);
    // Request IDs are unique within the authenticated instance/owner/realm.
    const old = [...this.journal.turns.values()].find(t => ownerKey(t.owner) === ownerKey(who) && t.requestId === requestId);
    if (old) {
      check(old.digest === requestDigest && old.sessionId === sessionId, 'request_id_conflict');
      const receipt = this.receipt(old);
      this.log({ direction: 'response', externalSessionId: session.externalSessionId, turnId: old.id, operation: 'session:sendMessage', phase: 'reused', status: 'turn_reused', result: 'accepted', inputFingerprint: fingerprint(body.input).sha256, detail: 'request id was already accepted' });
      return receipt;
    }
    const input = textBlocks(body.input);
    const plan = planHistory(session, body, { rich: this.adapter.richHistory });
    if (plan?.delta.length) check(this.adapter.historyVerified, 'history_readback_unverified', 422);
    check(![...this.journal.turns.values()].some(t => t.sessionId === sessionId && !terminal.has(t.state)), 'session_has_unresolved_turn');
    check(this.active.size < this.limits.globalConcurrency, 'global_concurrency_limit', 429);
    // Reserve synchronously before any await: both HTTP admission races and UI
    // prompt admission are covered by the same native lease.
    const lease = this.adapter.reserve(session.nativeSessionId, who, session.permissionMode);
    const t = { id: randomUUID(), sessionId, nativeSessionId: session.nativeSessionId, owner: who, requestId, digest: requestDigest,
      state: 'accepted', deliveryState: 'durable', seq: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      request: { input, history: plan }, approvals: {} };
    try { this.journal.commit({ turn: t }); } catch (e) { lease.release(); throw e; }
    this.active.set(t.id, { lease, promise: null });
    const promise = new Promise(resolve => setImmediate(resolve)).then(() => lease.run(() => this.run(t.id, session, plan, input)));
    this.active.get(t.id).promise = promise;
    void promise.finally(() => { lease.release(); this.active.delete(t.id); }).catch(() => {});
    const receipt = this.receipt(t);
    this.log({ direction: 'request', externalSessionId: session.externalSessionId, turnId: t.id, operation: 'session:sendMessage', phase: 'accepted', status: 'turn_accepted', result: 'accepted', inputFingerprint: fingerprint(input).sha256, detail: 'native turn accepted' });
    return receipt;
  }
  publish(id, type, payload, patch = {}, session) {
    const t = this.journal.turn(id);
    check(t && !terminal.has(t.state), 'turn_already_terminal');
    const event = { instanceId: t.owner.instanceId, ownerId: t.owner.ownerId, realm: t.owner.realm, sessionId: t.sessionId,
      nativeSessionId: t.nativeSessionId, turnId: id, requestId: t.requestId, seq: t.seq + 1, type, payload: redact(payload) };
    const turn = { ...t, ...patch, seq: event.seq, updatedAt: new Date().toISOString() };
    this.journal.commit({ turn, event, ...(session ? { session } : {}) });
    if (!['message.delta', 'reasoning.delta'].includes(type)) {
      const detail = typeof payload?.reason === 'string' ? payload.reason
        : typeof payload?.stopReason === 'string' ? payload.stopReason
          : typeof payload?.mode === 'string' ? payload.mode : undefined;
      const isFinal = ['completed','failed','cancelled','incomplete','in_doubt'].some(state => type === `turn.${state}`);
      const u = payload?.payload?.update ?? payload?.update ?? payload?.payload ?? payload;
      const tool = type === 'tool.call' || type === 'tool.update';
      this.log({ direction: 'response', externalSessionId: this.journal.session(t.sessionId)?.externalSessionId, turnId: id,
        operation: tool ? 'native:tool' : 'session:sendMessage', phase: type, status: type,
        result: isFinal ? type.slice(5) : tool && ['pending','in_progress','completed','failed','cancelled'].includes(u?.status) ? u.status : undefined,
        elapsedMs: isFinal ? Date.now() - Date.parse(t.createdAt) : undefined,
        outputFingerprint: isFinal || tool ? fingerprint(payload).sha256 : undefined, detail });
    }
  }
  failDelivery(id, e) {
    // Keep the original fault; the final durability check must not replace
    // journal_capacity_exceeded with a generic storage error.
    if (!this.deliveryFailures.has(id)) this.deliveryFailures.set(id, e?.code ?? 'delivery_storage_unavailable');
  }
  async run(id, session, plan, input) {
    let unsubscribe, pendingResult, dispatched = false;
    const observed = { pendingTools: new Set(), toolFailed: false, businessError: false, text: '', hasTools: false };
    try {
      const turn = this.journal.turn(id);
      await this.adapter.assertSession(turn.nativeSessionId, turn.owner);
      this.adapter.assertIdentity(turn.owner);
      if (turn.cancelRequested) { this.publish(id, 'turn.cancelled', { reason: 'cancelled_before_dispatch' }, { state: 'cancelled' }); return; }
      if (plan) {
        this.publish(id, 'history.importing', { revision: plan.revision, skipped: plan.skipped, idMap: plan.idMap }, { state: 'importing' });
        let imported;
        if (plan.delta.length) imported = await importHistory(this.adapter, turn.nativeSessionId, plan, null, intent => {
          this.journal.commit({ turn: { ...this.journal.turn(id), importIntent: intent } });
        });
        session.historySource = plan.source; session.historyRevision = plan.revision;
        session.historyProjection = plan.projection;
        const known = new Map((session.historyIdMap??[]).map(x=>[x.externalCallId,x]));
        for(const x of imported?.idMap??[])known.set(x.externalCallId,x);
        session.historyIdMap = plan.idMap.map(x=>known.get(x.externalCallId)??x);
        this.journal.commit({ session });
        if(imported)this.publish(id,'history.imported',imported);
      }
      this.adapter.assertIdentity(turn.owner);
      if (this.journal.turn(id).cancelRequested) { this.publish(id, 'turn.cancelled', { reason: 'cancelled_before_dispatch' }, { state: 'cancelled' }); return; }
      unsubscribe = this.adapter.subscribe(turn.nativeSessionId, raw => {
        if (this.deliveryFailures.has(id)) return;
        try {
          this.adapter.assertIdentity(turn.owner);
          let { type, payload } = normalizeEvent(raw);
          const p = raw.payload ?? raw, u = p.update ?? p;
          const patch = {};
          if (type === 'tool.call' || type === 'tool.update') {
            observed.hasTools = true;
            if (u.toolCallId) {
              if (['completed', 'failed', 'cancelled'].includes(u.status)) observed.pendingTools.delete(u.toolCallId);
              else observed.pendingTools.add(u.toolCallId);
              if (u.status === 'failed') observed.toolFailed = true;
            }
          }
          if (type === 'message.delta') {
            const blocks = Array.isArray(u.content) ? u.content : [u.content];
            for (const b of blocks) if (b?.type === 'text') observed.text += b.text;
          }
          if (type === 'approval.required' && p.requestId) {
            const approvals = this.journal.turn(id).approvals;
            // Official scoped and global channels broadcast the same request.
            // Preserve the second raw event, but never reopen an approval or
            // instruct an external consumer to decide the same request twice.
            if (Object.hasOwn(approvals, p.requestId)) type = 'native.event';
            else { patch.state = 'waiting_approval'; patch.approvals = { ...approvals, [p.requestId]: { pending: true } }; }
          }
          if (p.type === 'error' || raw.channel === 'queue:error') observed.businessError = true;
          this.publish(id, type, payload, patch);
        } catch (e) { this.failDelivery(id, e); }
      });
      this.publish(id, 'turn.started', { mode: 'native' }, { state: 'sending' });
      check(!this.deliveryFailures.has(id), 'delivery_storage_unavailable', 507);
      this.adapter.assertIdentity(turn.owner);
      dispatched = true;
      pendingResult = Promise.resolve(this.adapter.send(turn.nativeSessionId, input, turn.requestId, turn.owner));
      // Attach a rejection handler immediately even if a subsequent disk write
      // fails. The native operation must retain its lease until it really exits.
      pendingResult.catch(() => {});
      // Preserve synchronous native events (e.g. approval) that arrived on send.
      if (this.journal.turn(id).state === 'sending') this.journal.commit({ turn: { ...this.journal.turn(id), state: 'running' } });
      const result = await pendingResult;
      this.adapter.assertIdentity(turn.owner);
      check(!this.deliveryFailures.has(id), 'delivery_storage_unavailable', 507);
      const final = outcome(result, this.adapter.status(turn.nativeSessionId), observed);
      if (result?.usage) this.publish(id, 'usage', result.usage);
      // Echo checkpoint is safe only for a complete, text-only native exchange.
      // Tool/media histories require an actual native history projection.
      if (final.state === 'completed' && !observed.hasTools && observed.text) {
        session.historySource = [...session.historySource, { role: 'user', content: input }, { role: 'assistant', content: [{ type: 'text', text: observed.text }] }];
      }
      this.publish(id, `turn.${final.state}`, { ...final, result }, final, session);
    } catch (e) {
      if (e?.status === 507 || this.deliveryFailures.has(id)) { this.failDelivery(id, e); return; }
      const current = this.journal.turn(id);
      if (!current || terminal.has(current.state)) return;
      const ambiguous = dispatched || current.state === 'importing';
      try { this.publish(id, ambiguous ? 'turn.in_doubt' : 'turn.failed', { reason: e?.code ?? 'native_operation_failed' },
        { state: ambiguous ? 'in_doubt' : 'failed', reason: e?.code ?? 'native_operation_failed' }); }
      catch (writeError) { this.failDelivery(id, writeError); }
    } finally { if (pendingResult) await pendingResult.catch(() => {}); unsubscribe?.(); }
  }
  events(id, after) {
    const t = this.turn(id);
    check(Number.isSafeInteger(after) && after >= 0 && after <= t.seq, 'invalid_event_cursor', 400);
    return this.journal.page(id, after, this.limits.eventPage);
  }
  async cancel(id) {
    const t = this.turn(id);
    if (terminal.has(t.state) || t.cancelRequested) return this.status(id);
    check(this.active.has(id), 'turn_requires_reconciliation');
    this.adapter.assertIdentity(t.owner);
    this.publish(id, 'turn.cancel_requested', {}, { cancelRequested: true });
    if (['sending', 'running', 'waiting_approval'].includes(t.state)) await this.adapter.cancel(t.nativeSessionId, t.owner);
    const result = this.status(id);
    this.log({ direction: 'response', externalSessionId: this.journal.session(t.sessionId)?.externalSessionId, turnId: id, operation: 'session:cancel', phase: 'completed', status: result.state, result: result.state, detail: 'cancel requested' });
    return result;
  }
  async approve(id, approvalId, body) {
    noCallerIdentity(body);
    const t = this.turn(id); identifier(approvalId, 'approval_id');
    check(this.active.has(id) && !terminal.has(t.state) && t.approvals[approvalId]?.pending, 'approval_not_pending');
    check(typeof body.decision === 'string', 'explicit_approval_decision_required');
    check(!t.approvals[approvalId].dispatching, 'approval_already_dispatched');
    const result = await this.adapter.approve(t.nativeSessionId, approvalId, body.decision, t.owner, () => {
      const latest = this.journal.turn(id);
      check(!terminal.has(latest.state) && latest.approvals[approvalId]?.pending && !latest.approvals[approvalId].dispatching, 'approval_already_dispatched');
      this.publish(id, 'approval.dispatching', { approvalId, decision: body.decision }, { approvals: { ...latest.approvals, [approvalId]: { pending: true, dispatching: true } } });
    });
    check(result === true, 'native_approval_not_resolved');
    const latest = this.journal.turn(id);
    if (!terminal.has(latest.state)) this.publish(id, 'approval.resolved', { approvalId, decision: body.decision }, { state: 'running', approvals: { ...latest.approvals, [approvalId]: { pending: false } } });
    this.log({ direction: 'response', externalSessionId: this.journal.session(t.sessionId)?.externalSessionId, turnId: id, operation: 'session:approval', phase: 'resolved', status: 'approval_resolved', result: 'resolved', detail: body.decision });
    return { resolved: true };
  }
  async idle() { await Promise.allSettled([...this.active.values()].map(v => v.promise)); }
  async close() { check(!this.active.size && !this.pendingCreates.size, 'service_has_active_operations'); this.closed = true; }
}
