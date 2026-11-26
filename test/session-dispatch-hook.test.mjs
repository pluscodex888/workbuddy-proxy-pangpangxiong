import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionDispatch, compareEgressKinds } from '../src/session-dispatch-hook.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'workbaby-session-hook-'));

test('session observer preserves result and logs metadata only', async () => {
  const root = temp();
  const hook = createSessionDispatch({ dataRoot: root });
  const input = [{ type: 'text', text: 'secret-body' }];
  const value = { stopReason: 'end_turn' };
  assert.strictEqual(await hook({ sessionId: 'native-1', requestId: 'request-1', input, invoke: async () => value }), value);
  await new Promise(resolve => setTimeout(resolve, 20));
  const line = fs.readFileSync(path.join(root, 'session-dispatch-status.jsonl'), 'utf8');
  assert.ok(line.includes('"operation":"session:sendMessage"'));
  assert.ok(line.includes('"connectionKind":"daemon-rpc"'));
  const record = JSON.parse(line.trim().split(/\r?\n/).at(-1));
  assert.match(record.callFingerprint, /^[a-f0-9]{64}$/);
  assert.match(record.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.match(record.outputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(record.inputShape.type, 'array');
  assert.ok(!line.includes('secret-body'));
});

test('session observer rethrows native errors unchanged', async () => {
  const root = temp();
  const hook = createSessionDispatch({ dataRoot: root });
  const error = Object.assign(new Error('native failure'), { code: 'native_failure' });
  await assert.rejects(hook({ sessionId: 'native-1', requestId: 'request-1', invoke: async () => { throw error; } }), e => e === error);
  await new Promise(resolve => setTimeout(resolve, 20));
  const record = JSON.parse(fs.readFileSync(path.join(root, 'session-dispatch-status.jsonl'), 'utf8').trim().split(/\r?\n/).at(-1));
  assert.equal(record.outcome, 'error');
  assert.match(record.callFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(record.outputFingerprint, undefined);
});

test('session and provider records are explicitly separate connections', () => {
  assert.deepEqual(compareEgressKinds([{}], [{}, {}]), {
    status: 'observed', sessionRecords: 1, providerRecords: 2, sameConnection: false,
    reason: 'session-daemon-rpc-and-provider-network-are-separate-official-paths'
  });
});
