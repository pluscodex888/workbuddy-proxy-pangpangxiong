import {check, digest, identityKey} from './contracts.mjs';
import {officialCredits} from './http-node-credits.mjs';

// Authenticated gateway metadata. No bearer/session credentials or model body.
export function httpNodeIdentity(service) {
  const who = service.adapter.currentIdentity();
  return {
    protocol: 'workbaby.http/v1',
    account_uid: who.ownerId,
    realm: who.realm,
    instance_id: who.instanceId,
    identity_fingerprint: digest([who.instanceId, who.ownerId, who.realm]),
    api_base_path: '/v1',
    authentication: 'one-service-key',
    request_encodings: ['identity','gzip'],
  };
}

export function assertHttpNodeBinding(service, headers) {
  const expected = headers['x-workbaby-expected-identity'];
  if (expected === undefined) return;
  check(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), 'invalid_node_binding', 400);
  check(expected === httpNodeIdentity(service).identity_fingerprint, 'node_account_changed', 409);
}

export async function httpNodeMetadata(service) {
  const before = {...service.adapter.currentIdentity()}, node = httpNodeIdentity(service);
  let paid = null, credits = null;
  try {
    // Existing official AuthService action; no new upstream client or headers.
    const usage = await service.adapter.daemon?.server?.invokeLocal('auth:getAccountUsage');
    if (typeof usage?.isPro === 'boolean') paid = usage.isPro;
    credits = officialCredits(usage, Date.now()/1000);
  } catch { /* Unknown rights remain unknown; model inference is never a probe. */ }
  check(identityKey(before) === identityKey(service.adapter.currentIdentity()), 'identity_changed', 409);
  return {...node, membership:{paid, checked_at:Date.now()/1000, source:'official-auth-service'}, credits};
}
