import http from 'node:http';
import https from 'node:https';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function cleanHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'host' || key === 'content-length' || key === 'authorization') continue;
    result[key] = value;
  }
  return result;
}

function sendError(res, status, code) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify({ error: code }));
}

function abortRequest(upstream, res) {
  upstream.destroy();
  if (!res.headersSent && !res.destroyed) sendError(res, 499, 'downstream_client_closed');
  else if (!res.destroyed) res.destroy();
}

/**
 * Forward the already-read inbound bytes to one configured HTTP endpoint.
 * The body is never parsed or re-serialized here, so JSON and SSE framing
 * remain the downstream service's responsibility.
 */
export function relayHttp({ targetUrl, method = 'POST', inboundHeaders = {}, body, res, bearerToken, timeoutMs = 120_000 }) {
  const target = new URL(targetUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('downstream_http_url_required');
  if (!Buffer.isBuffer(body)) throw new Error('downstream_body_buffer_required');

  const headers = cleanHeaders(inboundHeaders);
  headers.host = target.host;
  headers['content-length'] = String(body.length);
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

  const client = target.protocol === 'https:' ? https : http;
  const upstream = client.request(target, { method, headers });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    abortRequest(upstream, res);
  };
  res.once('close', close);
  upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('downstream_timeout')));
  upstream.once('response', response => {
    if (closed) return;
    // The timeout protects connection/headers only. Once a stream exists,
    // downstream heartbeats and backpressure control its lifetime.
    upstream.setTimeout(0);
    const responseHeaders = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders[name] = value;
    }
    res.writeHead(response.statusCode ?? 502, responseHeaders);
    // Pipe keeps JSON, SSE, compression, and chunk boundaries under the
    // downstream server's control, matching the server-assistant proxy.
    response.pipe(res);
    response.once('error', error => res.destroy(error));
  });
  upstream.once('error', error => {
    if (closed) return;
    closed = true;
    res.removeListener('close', close);
    if (!res.headersSent) sendError(res, 502, error.message === 'downstream_timeout' ? 'downstream_timeout' : 'downstream_unavailable');
    else res.destroy(error);
  });
  upstream.end(body);
  return upstream;
}
