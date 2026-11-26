import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fp from './fingerprint.cjs';
const { fingerprint, sha256 } = fp;

export function createSessionDispatch(config = {}) {
  const file = config.diagnosticPath ?? (config.dataRoot ? path.join(config.dataRoot, 'session-dispatch-status.jsonl') : null);
  const write = record => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 }); } catch {}
  };
  return async function sessionDispatch(context) {
    const started = Date.now(), callId = randomUUID(), input = fingerprint(context.input);
    const base = { schema: 2, callId, startedAt: new Date(started).toISOString(), transport: 'workbuddy-session', operation: 'session:sendMessage',
      connectionKind: 'daemon-rpc', networkOwner: 'workbuddy-official-cli-provider', sessionIdSha256: sha256(context.sessionId), requestIdSha256: sha256(context.requestId),
      inputFingerprint: input.sha256, inputComplete: input.complete, inputShape: input.shape, inputUnavailable: input.reason,
      callFingerprint: fingerprint({ operation: 'session:sendMessage', sessionId: context.sessionId, requestId: context.requestId, input: context.input }).sha256,
      pid: process.pid, ppid: process.ppid };
    write({ ...base, at: base.startedAt, outcome: 'started' });
    try {
      const result = await context.invoke(), output = fingerprint(result);
      write({ ...base, at: new Date().toISOString(), outcome: 'returned', elapsedMs: Date.now() - started,
        outputFingerprint: output.sha256, outputComplete: output.complete, outputShape: output.shape, outputUnavailable: output.reason });
      return result;
    } catch (error) {
      write({ ...base, at: new Date().toISOString(), outcome: 'error', elapsedMs: Date.now() - started,
        errorFingerprint: fingerprint({ name: error?.name, code: error?.code }).sha256 });
      throw error;
    }
  };
}
export function compareEgressKinds(sessionRecords = [], providerRecords = []) {
  return { status: 'observed', sessionRecords: sessionRecords.length, providerRecords: providerRecords.length, sameConnection: false,
    reason: 'session-daemon-rpc-and-provider-network-are-separate-official-paths' };
}
