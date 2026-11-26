import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mountNativeBridge } from '../src/public-native.mjs';

test('public bridge authenticates native endpoints and rejects compatibility and unattended tool mode', async t => {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'workbaby-public-'));
  const manager = { getSession() {}, getSessionRecord() {}, prompt() {} };
  const originalPrompt = manager.prompt;
  const daemon = {
    sessionManager: manager,
    server: { onPush() {}, invokeLocal() { assert.fail('unexpected daemon call'); } }
  };
  const token = randomBytes(32).toString('hex');
  const bridge = await mountNativeBridge({
    daemon, dataRoot, token, allowedWorkspaces: [dataRoot],
    getIdentity: () => ({ instanceId: 'demo', ownerId: 'demo-owner', realm: 'demo', generation: '1' })
  });
  t.after(async () => {
    await bridge.close();
    rmSync(dataRoot, { recursive: true });
  });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${bridge.url}/capabilities`)).status, 401);
  const capabilities = await (await fetch(`${bridge.url}/capabilities`, { headers })).json();
  assert.equal(capabilities.native, true);
  assert.equal(capabilities.raw, false);
  assert.equal((await fetch(`${new URL(bridge.url).origin}/v1/models`, { headers })).status, 404);
  assert.equal((await fetch(`${bridge.url}/diagnostics/activity`, { headers })).status, 404);
  const unattended = await fetch(`${bridge.url}/sessions`, {
    method: 'POST', headers,
    body: JSON.stringify({ cwd: dataRoot, externalSessionId: 'demo', executionMode: 'native', permissionMode: 'bypassPermissions' })
  });
  assert.equal(unattended.status, 403);
  assert.equal((await unattended.json()).error, 'permission_mode_not_allowed');
  await bridge.close();
  assert.equal(manager.prompt, originalPrompt);
});
