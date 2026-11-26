import { createHash } from 'node:crypto';

export class BridgeError extends Error {
  constructor(code, status = 409, upstream) { super(code); this.code = code; this.status = status; if(upstream)this.upstream=upstream; }
}
export function check(value, code, status = 400) { if (!value) throw new BridgeError(code, status); }
export const terminal = new Set(['completed', 'failed', 'cancelled', 'incomplete']);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function identifier(value, name = 'id') {
  check(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value), `invalid_${name}`);
  return value;
}
export function identity(value) {
  check(value && typeof value === 'object', 'not_authenticated', 401);
  for (const key of ['instanceId', 'ownerId', 'realm', 'generation']) identifier(value[key], key);
  return Object.fromEntries(['instanceId', 'ownerId', 'realm', 'generation'].map(k => [k, value[k]]));
}
export const identityKey = value => canonical(identity(value));
export const ownerKey = value => canonical([value.instanceId, value.ownerId, value.realm]);
export function noCallerIdentity(body) {
  check(body && typeof body === 'object' && !Array.isArray(body), 'invalid_body');
  for (const key of ['ownerId', 'instanceId', 'realm', 'generation', 'token', 'upstreamUrl', 'endpoint']) {
    check(!Object.hasOwn(body, key), 'caller_identity_or_endpoint_forbidden');
  }
}
export function textBlocks(blocks) {
  check(Array.isArray(blocks) && blocks.length > 0 && blocks.length <= 128, 'invalid_input');
  check(blocks.every(b => b && b.type === 'text' && typeof b.text === 'string' && Object.keys(b).every(k => ['type', 'text'].includes(k))), 'input_content_not_supported', 422);
  check(blocks.some(b => b.text.trim()), 'empty_prompt_not_supported', 422);
  return structuredClone(blocks);
}
export const limitsDefault = Object.freeze({ globalConcurrency: 4, inputBytes: 1024 * 1024, rawInputBytes: 16 * 1024 * 1024, journalBytes: 64 * 1024 * 1024, attachments: 0, retention: 'manual-no-auto-delete', eventPage: 128 });
// Structured secrets are removed without changing ordinary text or unknown event types.
// Conversation text is private runtime data and is never included in evidence reports.
export function redact(value, depth = 0) {
  if (depth > 64) return '[depth-limit]';
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /^(authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|password|proxyPassword)$/i.test(k) ? '[redacted]' : redact(v, depth + 1)]));
  return value;
}
