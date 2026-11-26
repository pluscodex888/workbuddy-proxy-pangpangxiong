import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { BridgeError, check, identity, identityKey } from './contracts.mjs';
import { createSessionDispatch } from './session-dispatch-hook.mjs';

/** In-process adapter for the pinned WorkBuddy daemon. Never enables eval mode,
 * replaces provider networking, or owns the SDK's onSessionUpdate callback. */
export class WorkBuddyAdapter {
  constructor({ daemon, getIdentity, historyPort, verified = {}, sessionDispatch, dataRoot, rateLimits }) {
    this.rateLimits=rateLimits;
    this.daemon = daemon; this.getIdentity = getIdentity; this.historyPort = historyPort;
    this.sessionDispatch = typeof sessionDispatch === 'function' ? sessionDispatch : createSessionDispatch({ dataRoot });
    this.verified = verified; this.leases = new Map(); this.scope = new AsyncLocalStorage();
    const manager = daemon?.sessionManager;
    check(typeof daemon?.server?.invokeLocal === 'function' && typeof daemon?.server?.onPush === 'function' && typeof manager?.getSession === 'function' && typeof manager?.getSessionRecord === 'function' && typeof manager?.prompt === 'function', 'daemon_boundary_unavailable', 503);
    check(typeof getIdentity === 'function', 'trusted_identity_required', 503);
    this.originalPrompt = manager.prompt;
    this.originalResolveRuntimeConfig = manager.resolveRuntimeConfig;
    this.originalBuildDesiredConfig = manager.buildDesiredConfig;
    const adapter = this;
    if (typeof this.originalBuildDesiredConfig === 'function') {
      this.buildDesiredWrapper = function (input, ...args) {
        const context = adapter.scope.getStore();
        if (context?.restoring && input.sessionId === context.sessionId) {
          adapter.assertIdentity(context.identity);
          input = { ...input, config: { ...input.config, ...context.restoreConfig } };
        }
        return adapter.originalBuildDesiredConfig.call(this, input, ...args);
      };
      manager.buildDesiredConfig = this.buildDesiredWrapper;
    }
    if (typeof this.originalResolveRuntimeConfig === 'function') {
      this.resolveRuntimeWrapper = async function (input, ...args) {
        const result = await adapter.originalResolveRuntimeConfig.call(this, input, ...args);
        const context = adapter.scope.getStore();
        if (context?.sessionId === input.sessionId && context.permissionMode) {
          check(result?.permissionMode === context.permissionMode, 'native_permission_mode_mismatch');
        }
        return result;
      };
      manager.resolveRuntimeConfig = this.resolveRuntimeWrapper;
    }
    this.promptWrapper = function (sessionId, ...args) {
      const context = adapter.scope.getStore(), lease = adapter.leases.get(sessionId);
      if (context?.providerOnly) return Promise.reject(new BridgeError('raw_native_prompt_forbidden'));
      if (lease && context !== lease) return Promise.reject(new BridgeError('native_session_busy'));
      if (context && context.sessionId === sessionId) {
        check(!context.restoring, 'native_restore_cannot_prompt');
        adapter.assertIdentity(context.identity);
        adapter.assertPermission(sessionId, context.permissionMode);
        if (context.sent) return Promise.reject(new BridgeError('native_prompt_already_sent'));
        context.sent = true;
        return adapter.observePrompt(()=>adapter.originalPrompt.call(this, sessionId, ...args));
      }
      // UI sends use the same lock, including time spent awaiting admission.
      const localLease = { sessionId, local: true };
      adapter.leases.set(sessionId, localLease);
      try {
        return adapter.observePrompt(()=>adapter.originalPrompt.call(this, sessionId, ...args)).finally(() => {
          if (adapter.leases.get(sessionId) === localLease) adapter.leases.delete(sessionId);
        });
      } catch (e) { adapter.leases.delete(sessionId); throw e; }
    };
    manager.prompt = this.promptWrapper;
    this.historyVerified = historyPort?.verified === true;
    this.richHistory = this.historyVerified && historyPort.rich === true;
  }
  currentIdentity() {
    try { return identity(this.getIdentity()); }
    catch (e) { if (e.code === 'official_login_required') throw new BridgeError('official_login_required', 401); throw e; }
  }
  async observePrompt(invoke){
    const ticket=this.rateLimits?.begin(this.currentIdentity().ownerId);
    try{const value=await invoke();this.rateLimits?.finish(ticket,value,{success:value?.stopReason==='end_turn'&&!value.error&&!value.isError&&!value?._meta?.['codebuddy.ai']?.error});return value;}
    catch(error){this.rateLimits?.finish(ticket,error);throw error;}
  }
  assertIdentity(expected) { check(identityKey(this.currentIdentity()) === identityKey(expected), 'identity_changed', 409); }
  capabilities() {
    return { native: true, raw: false, rawReason: 'provider_exclusive_scope_unverified', protocol: 'acp-v1',
      history: this.historyVerified ? (this.richHistory ? 'rich-v1' : 'simple-readback') : false,
      mediaInput: false, cancel: true, approvals: true, questionResponse: false,
      permissionScenes: { default: 'ask', acceptEdits: 'ask', plan: 'plan', bypassPermissions: 'craft' },
      validation: { staticSample: '5.7.6.40488862', ...this.verified } };
  }
  async create(config, expected) {
    this.assertIdentity(expected);
    // Official craft mode upgrades default/acceptEdits to bypassPermissions.
    // Select its permission-preserving scene and verify the resolved runtime.
    const mode = this.capabilities().permissionScenes[config.permissionMode];
    check(mode, 'native_permission_mode_unsupported');
    const result = await this.daemon.server.invokeLocal('session:create', { cwd: config.cwd, config: { mode, permissionMode: config.permissionMode, permissionModeBeforePlan: config.permissionMode === 'plan' ? 'default' : config.permissionMode, ...(config.model ? { model: config.model } : {}) } });
    this.assertIdentity(expected);
    check(typeof result?.sessionId === 'string' && result.sessionId, 'native_create_result_ambiguous');
    await this.assertSession(result.sessionId, expected);
    this.assertPermission(result.sessionId, config.permissionMode);
    return result.sessionId;
  }
  async assertSession(sessionId, expected) {
    this.assertIdentity(expected);
    const m = this.daemon.sessionManager;
    const record = await m.getSessionRecord(sessionId);
    this.assertIdentity(expected);
    check(record && (record.sessionId ?? record.id) === sessionId && record.userId === expected.ownerId, 'native_session_owner_mismatch');
  }
  async load(sessionId, cwd, expected, config) {
    await this.assertSession(sessionId, expected);
    const manager = this.daemon.sessionManager;
    check(typeof manager.loadSession === 'function', 'native_restore_boundary_unavailable');
    check(!this.leases.has(sessionId), 'native_session_busy');
    const existing = manager.getSession(sessionId);
    // Never overwrite configuration of a session already opened by the UI.
    if (existing) this.assertPermission(sessionId, config.permissionMode);
    else check(this.buildDesiredWrapper && manager.buildDesiredConfig === this.buildDesiredWrapper, 'native_restore_boundary_unavailable');
    const mode = this.capabilities().permissionScenes[config.permissionMode];
    check(mode, 'native_permission_mode_unsupported');
    const lease = { sessionId, identity: expected, permissionMode: config.permissionMode, restoring: true,
      restoreConfig: { mode, permissionMode: config.permissionMode, permissionModeBeforePlan: config.permissionMode === 'plan' ? 'default' : config.permissionMode, ...(config.model ? { model: config.model } : {}) } };
    this.leases.set(sessionId, lease);
    try {
      // The renderer RPC only fetches cloud replay and can leave no runtime.
      // Use the pinned manager lifecycle, which restores the CLI backend too.
      await this.scope.run(lease, () => manager.loadSession(sessionId, cwd));
      await this.assertSession(sessionId, expected);
      this.assertPermission(sessionId, config.permissionMode);
    } finally { if (this.leases.get(sessionId) === lease) this.leases.delete(sessionId); }
  }
  assertPermission(sessionId, permissionMode) {
    check(typeof permissionMode === 'string', 'native_permission_mode_required');
    const runtime = this.daemon.sessionManager.sessions?.get(sessionId)?.runtimeConfig;
    check(runtime, 'native_session_not_loaded');
    check(runtime?.permissionMode === permissionMode, 'native_permission_mode_mismatch');
  }
  reserve(sessionId, expected, permissionMode) {
    this.assertIdentity(expected);
    this.assertPermission(sessionId, permissionMode);
    check(!this.leases.has(sessionId), 'native_session_busy');
    const state = this.daemon.sessionManager.getSession(sessionId);
    check(state && state.sessionId === sessionId, 'native_session_not_loaded');
    check(!state.isProcessing && !state.stopRequested && !state.pendingPermissions?.length && !state.pendingQuestions?.length && !state.pendingElicitations?.length, 'native_session_busy');
    const lease = { sessionId, identity: expected, permissionMode, token: randomUUID(), sent: false };
    this.leases.set(sessionId, lease);
    return {
      run: action => this.scope.run(lease, action),
      release: () => { if (this.leases.get(sessionId) === lease) this.leases.delete(sessionId); }
    };
  }
  subscribe(sessionId, listener) {
    return this.daemon.server.onPush((channel, payload) => {
      if (payload?.sessionId === sessionId) listener({ channel, payload });
    });
  }
  async prepareProviderRequest(sessionId, expected) {
    await this.assertSession(sessionId, expected);
    const lease=this.leases.get(sessionId), manager=this.daemon.sessionManager;
    check(lease && !lease.local && identityKey(lease.identity)===identityKey(expected), 'raw_prepare_requires_lease');
    check(typeof manager.withReadySession==='function' && typeof manager.resolveBackendForPromptSend==='function' && typeof manager.onBeforePrompt==='function', 'raw_native_prepare_unavailable', 503);
    // Reuse the official pre-send lifecycle. It refreshes official device
    // attestation and plugin/session request metadata through native services.
    // We neither read/copy tokens nor invoke prompt/runner/tool execution.
    await this.scope.run({...lease,providerOnly:true},()=>manager.withReadySession(sessionId,async state=>{
      check(state===manager.sessions?.get(sessionId) && state.sessionId===sessionId && !state.isProcessing && !state.promptInvocationActive, 'raw_session_busy');
      await manager.resolveBackendForPromptSend(state);
    }));
    this.assertIdentity(expected);
    this.assertPermission(sessionId,lease.permissionMode);
  }
  async releaseProviderSession(sessionId, expected) {
    await this.assertSession(sessionId, expected);
    const lease=this.leases.get(sessionId), manager=this.daemon.sessionManager;
    check(lease && !lease.local && identityKey(lease.identity)===identityKey(expected), 'raw_release_requires_lease');
    const state=manager.getSession(sessionId);
    check(state && !state.isProcessing && !state.promptInvocationActive && !state.stopRequested && !state.pendingPermissions?.length && !state.pendingQuestions?.length && !state.pendingElicitations?.length, 'raw_session_busy');
    check(typeof manager.destroySession==='function', 'raw_runtime_release_unavailable',503);
    // The official lifecycle drops only the live CLI/backend. Its persisted
    // session and the bridge's HTTP receipts remain available for a later load.
    await manager.destroySession(sessionId);
    check(!manager.getSession(sessionId), 'raw_runtime_release_incomplete');
  }
  send(sessionId, input, requestId, expected) {
    this.assertIdentity(expected);
    const meta = { 'codebuddy.ai': { requestId } };
    const invoke = () => this.daemon.server.invokeLocal('session:sendMessage', sessionId, input, meta);
    return this.sessionDispatch({ sessionId, requestId, input, meta, invoke });
  }
  async cancel(sessionId, expected) {
    await this.assertSession(sessionId, expected);
    return this.daemon.server.invokeLocal('session:cancel', sessionId);
  }
  async approve(sessionId, approvalId, decision, expected, beforeDispatch = () => {}) {
    await this.assertSession(sessionId, expected);
    const pending = this.daemon.sessionManager.getSession(sessionId)?.pendingPermissions?.find(p => p.requestId === approvalId);
    check(pending, 'approval_not_pending');
    const options = pending.request?.options ?? [];
    if (decision === 'reject') { beforeDispatch(); return this.daemon.server.invokeLocal('session:rejectPermission', sessionId, approvalId, 'User rejected'); }
    check(options.some(o => o.optionId === decision), 'invalid_approval_option', 400);
    beforeDispatch();
    return this.daemon.server.invokeLocal('session:resolvePermission', sessionId, approvalId, decision);
  }
  status(sessionId) { return this.daemon.sessionManager.getSession(sessionId); }
  readHistory(sessionId) { return this.historyPort.read(sessionId); }
  injectHistory(sessionId, items) { return this.historyPort.inject(sessionId, items); }
  dispose() {
    check(this.leases.size === 0, 'adapter_has_active_sessions');
    if (this.daemon.sessionManager.prompt === this.promptWrapper) this.daemon.sessionManager.prompt = this.originalPrompt;
    if (this.resolveRuntimeWrapper && this.daemon.sessionManager.resolveRuntimeConfig === this.resolveRuntimeWrapper) this.daemon.sessionManager.resolveRuntimeConfig = this.originalResolveRuntimeConfig;
    if (this.buildDesiredWrapper && this.daemon.sessionManager.buildDesiredConfig === this.buildDesiredWrapper) this.daemon.sessionManager.buildDesiredConfig = this.originalBuildDesiredConfig;
  }
}
