import http from 'node:http';
import {gunzipSync} from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError, check, terminal, identifier, noCallerIdentity } from './contracts.mjs';
import {readOfficialActivity} from './native-activity.mjs';
import { relayHttp } from './http-downstream-relay.mjs';
import {rawModelListing,isNonPublicRawModel,resolveRawModel} from './raw-model-catalog.mjs';
import {safeUpstreamDetails} from './upstream-error.cjs';
import {httpNodeMetadata, assertHttpNodeBinding} from './http-node-identity.mjs';
import storage from './runtime-storage.cjs';

function inputLimitError(limit,wireBytes,decodedOverflow=false){
  return Object.assign(new BridgeError('input_too_large',413),{requestSize:{limit_bytes:limit,wire_bytes:wireBytes,...decodedOverflow?{decoded_bytes_min:limit+1}:{}}});
}
function publicErrorDetails(error){
  const out={};
  for(const [k,v] of Object.entries(error.requestSize??{}))if(['limit_bytes','wire_bytes','decoded_bytes_min'].includes(k)&&Number.isSafeInteger(v)&&v>=0)out[k]=v;
  return {...out,...error.storageDetails};
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function readBody(req, limit) {
  check(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''), 'json_content_type_required', 415);
  let bytes = 0; const parts = [];
  const chunks=typeof req.iterator==='function'?req.iterator({destroyOnReturn:false}):req;
  try{for await (const chunk of chunks) {
    bytes += chunk.length;if(bytes>limit)throw inputLimitError(limit,bytes);parts.push(chunk);
  }}catch(e){if(e.code==='input_too_large')req.resume();throw e;}
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new BridgeError('invalid_json', 400); }
}
async function readRawBody(req, limit) {
  check(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''), 'json_content_type_required', 415);
  const encoding=(req.headers['content-encoding']??'identity').toLowerCase();
  check(encoding==='identity'||encoding==='gzip','unsupported_content_encoding',415);
  let bytes = 0; const parts = [];
  const chunks=typeof req.iterator==='function'?req.iterator({destroyOnReturn:false}):req;
  try{for await (const chunk of chunks) {
    bytes += chunk.length;if(bytes>limit)throw inputLimitError(limit,bytes);parts.push(chunk);
  }}catch(e){if(e.code==='input_too_large')req.resume();throw e;}
  const raw = Buffer.concat(parts);
  let decoded=raw;
  if(encoding==='gzip'){
    try{decoded=gunzipSync(raw,{maxOutputLength:limit});}
    catch(e){if(e.code==='ERR_BUFFER_TOO_LARGE')throw inputLimitError(limit,bytes,true);throw new BridgeError('invalid_gzip',400);}
  }
  try { return { raw, value: JSON.parse(decoded.toString('utf8')) }; } catch { throw new BridgeError('invalid_json', 400); }
}
function pause(ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
function write(res, bytes, signal) {
  if (signal.aborted) return Promise.resolve(false);
  if (res.write(bytes)) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = ok => { clearTimeout(timer); res.off('drain', drain); signal.removeEventListener('abort', abort); resolve(ok); };
    const drain = () => finish(true), abort = () => finish(false);
    const timer = setTimeout(() => { res.destroy(); finish(false); }, 30_000);
    res.once('drain', drain); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function chatText(content) {
  if (typeof content === 'string') return content;
  check(Array.isArray(content) && content.length > 0, 'chat_message_content_required', 422);
  const text = content.map(block => {
    check(block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string', 'chat_content_block_unsupported', 422);
    return block.text;
  }).join('');
  check(text.length > 0, 'chat_message_content_required', 422);
  return text;
}

function chatPrompt(messages) {
  // The HTTP reader already bounds request bytes. Conversation length is not
  // a per-turn batch limit; preserve the entire admitted history.
  check(Array.isArray(messages) && messages.length > 0, 'chat_messages_required', 422);
  return messages.map(message => {
    check(message && typeof message === 'object' && ['system','developer','user','assistant','tool'].includes(message.role), 'chat_message_role_unsupported', 422);
    const label = message.role === 'tool' ? 'tool' : message.role;
    return `<|${label}|>\n${chatText(message.content)}`;
  }).join('\n\n') + '\n\n<|assistant|>\n';
}

function chatDelta(event) {
  if (event.type !== 'message.delta') return '';
  const payload = event.payload?.payload ?? event.payload ?? {}, update = payload.update ?? payload;
  const blocks = Array.isArray(update.content) ? update.content : [update.content];
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
}

async function chatCompletion(service, body, req, res) {
  noCallerIdentity(body);
  check(typeof body.model === 'string' && body.model.length > 0, 'chat_model_required', 422);
  check(body.tools === undefined && body.tool_choice === undefined, 'chat_tools_not_supported', 422);
  const prompt = chatPrompt(body.messages), stream = body.stream === true;
  const workspace = service.allowedWorkspaces[0];
  check(typeof workspace === 'string', 'workspace_not_configured', 403);
  const headerSession = req.headers['x-workbaby-session-id'];
  const externalSessionId = headerSession ? identifier(headerSession, 'session_id') : typeof body.user === 'string' && body.user.length ? identifier(body.user, 'user') : `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestId = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'] ? identifier(req.headers['x-request-id'], 'request_id') : `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const session = await service.createSession({ externalSessionId, executionMode: 'native', cwd: workspace, permissionMode: 'default', model: body.model });
  const receipt = await service.submit(session.sessionId, { schema: 'workbaby.session-turn/v1', requestId, externalSessionId, executionMode: 'native', input: [{ type: 'text', text: prompt }] });
  res.setHeader('X-Workbaby-Session-Id', externalSessionId);
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Workbaby-Turn-Id', receipt.turnId);
  const id = `chatcmpl-${receipt.turnId}`, created = Math.floor(Date.now() / 1000), controller = new AbortController();
  res.once('close', () => controller.abort());
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    await write(res, `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`, controller.signal);
  }
  let cursor = 0, output = '', final;
  const started = Date.now();
  while (!controller.signal.aborted && Date.now() - started < 300_000) {
    for (const event of service.events(receipt.turnId, cursor)) {
      cursor = event.seq;
      const text = chatDelta(event); if (!text) continue;
      output += text;
      if (stream && !await write(res, `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`, controller.signal)) return;
    }
    final = service.status(receipt.turnId);
    const stopped = terminal.has(final.state) || final.state === 'in_doubt' || final.deliveryState === 'failed';
    // A completed native turn can have several committed pages. Drain all of
    // them before ending the HTTP response, including when replaying a turn.
    if (stopped && cursor >= (final.committedSeq ?? cursor)) break;
    if (cursor < (final.committedSeq ?? cursor)) continue;
    await pause(50, controller.signal);
  }
  if (!final) final = service.status(receipt.turnId);
  const finish = final.state === 'completed' ? 'stop' : final.state === 'cancelled' ? 'cancelled' : 'error';
  if (stream) {
    await write(res, `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, controller.signal);
    if (!res.destroyed) res.end();
    return;
  }
  if (final.state !== 'completed') throw new BridgeError(final.reason ?? 'native_turn_not_completed', 502);
  return json(res, 200, { id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }], usage: null });
}

function chatModels(service) {
  if(service.rawHttp)return {object:'list',data:rawModelListing(service.rawHttp.modelCatalog)};
  const current = service.adapter.currentIdentity ? 'workbuddy-native' : 'workbaby';
  return { object: 'list', data: [{ id: current, object: 'model', created: 0, owned_by: 'workbaby' }] };
}
async function streamEvents(service, id, cursor, req, res) {
  service.events(id, cursor); // Validate access and cursor before sending headers.
  const controller = new AbortController();
  res.once('close', () => controller.abort()); res.on('error', () => controller.abort());
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let heartbeatAt = Date.now();
  try {
    while (!controller.signal.aborted) {
      const events = service.events(id, cursor);
      for (const event of events) {
        // Access is rechecked after backpressure, so account switches cannot
        // continue draining a previously authorized owner's buffered page.
        service.turn(id);
        if (!await write(res, `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, controller.signal)) return;
        cursor = event.seq;
      }
      const status = service.status(id);
      if ((terminal.has(status.state) || status.state === 'in_doubt' || status.deliveryState === 'failed') && cursor >= status.committedSeq) { res.end(); return; }
      if (!events.length) {
        if (Date.now() - heartbeatAt >= 15_000) {
          if (!await write(res, ': keepalive\n\n', controller.signal)) return;
          heartbeatAt = Date.now();
        }
        await pause(100, controller.signal);
      }
    }
  } finally { controller.abort(); }
}

export async function startHttpApi(service, {
  token, port = 0, nativeOnly = false,
  downstreamUrl = nativeOnly ? undefined : process.env.WORKBABY_DOWNSTREAM_URL,
  downstreamBearerToken = nativeOnly ? undefined : process.env.WORKBABY_DOWNSTREAM_BEARER,
  downstreamTimeoutMs = Number((nativeOnly ? undefined : process.env.WORKBABY_DOWNSTREAM_TIMEOUT_MS) ?? 120_000)
} = {}) {
  check(typeof token === 'string' && Buffer.byteLength(token) >= 32 && !/[\r\n]/.test(token), 'configured_service_credential_required');
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid_port');
  if (downstreamUrl !== undefined) {
    check(typeof downstreamUrl === 'string' && downstreamUrl.length > 0, 'invalid_downstream_url');
    const parsed = new URL(downstreamUrl);
    check(parsed.protocol === 'http:' || parsed.protocol === 'https:', 'invalid_downstream_protocol');
  }
  if (downstreamBearerToken !== undefined) check(typeof downstreamBearerToken === 'string' && downstreamBearerToken.length > 0 && !/[\r\n]/.test(downstreamBearerToken), 'invalid_downstream_credential');
  check(Number.isInteger(downstreamTimeoutMs) && downstreamTimeoutMs > 0 && downstreamTimeoutMs <= 900_000, 'invalid_downstream_timeout');
  const expected = Buffer.from(`Bearer ${token}`), readers = new Set();
  const server = http.createServer(async (req, res) => {
    readers.add(res); res.once('close', () => readers.delete(res));
    let openAiRoute = false;
    try {
      check(!req.headers.origin, 'browser_origin_forbidden', 403);
      check(req.headers.host === `127.0.0.1:${server.address().port}`, 'invalid_host', 403);
      const supplied = Buffer.from(req.headers.authorization ?? '');
      check(supplied.length === expected.length && timingSafeEqual(supplied, expected), 'unauthorized', 401);
      const url = new URL(req.url, 'http://127.0.0.1'), parts = url.pathname.split('/').filter(Boolean);
      openAiRoute = url.pathname === '/v1/models' || url.pathname === '/v1/chat/completions' || url.pathname === '/workbaby/v1/chat/completions';
      if (nativeOnly && (openAiRoute || parts[2] === 'diagnostics')) {
        openAiRoute = false;
        throw new BridgeError('not_found', 404);
      }
      if(openAiRoute&&/^[A-Za-z0-9._:-]{1,200}$/.test(req.headers['x-request-id']??''))res.setHeader('X-Request-Id',req.headers['x-request-id']);
      if(req.method==='GET'&&url.pathname==='/workbaby/v1/diagnostics/activity')return json(res,200,await (service.logStore?.readActivity?.()??readOfficialActivity(service.adapter)));
      if (req.method === 'GET' && url.pathname === '/workbaby/v1/diagnostics/models' && service.rawHttp) {
        return json(res, 200, { object: 'workbaby.model-diagnostics', models: rawModelListing(service.rawHttp.modelCatalog), apiBasePath:'/v1', authentication:{scope:'service',perModelKeys:false} });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, {...chatModels(service), workbaby_node:await httpNodeMetadata(service)});
      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/workbaby/v1/chat/completions')) {
        const inbound = await readRawBody(req, service.limits.rawInputBytes??service.limits.inputBytes);
        noCallerIdentity(inbound.value);
        // Check after reading the body, immediately before dispatch. A login
        // switch while a caller uploads must never attribute the new account
        // to the gateway's previously registered Windows node.
        assertHttpNodeBinding(service, req.headers);
        check(!isNonPublicRawModel(inbound.value.model,service.rawHttp?.modelCatalog),'model_not_public',403);
        if(service.rawHttp)check(resolveRawModel(inbound.value.model,service.rawHttp.modelCatalog),'model_not_public',403);
        if (downstreamUrl) {
          relayHttp({ targetUrl: downstreamUrl, method: req.method, inboundHeaders: req.headers, body: inbound.raw, res, bearerToken: downstreamBearerToken, timeoutMs: downstreamTimeoutMs });
          return;
        }
        if(service.rawHttp)return await service.rawHttp.complete(inbound.value,req,res);
        return await chatCompletion(service, inbound.value, req, res);
      }
      check(parts[0] === 'workbaby' && parts[1] === 'v1', 'not_found', 404);
      if (parts.length === 4 && parts[2] === 'diagnostics' && parts[3] === 'timeline' && service.logStore) {
        service.adapter.currentIdentity();
        if (req.method === 'GET') return json(res, 200, service.logStore.snapshot());
        if (req.method === 'POST') {
          const body = await readBody(req, 1024);
          check(typeof body.enabled === 'boolean', 'enabled_boolean_required');
          return json(res, 200, service.logStore.setEnabled(body.enabled));
        }
      }
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'capabilities') return json(res, 200, service.capabilities());
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'sessions') return json(res, 201, await service.createSession(await readBody(req, service.limits.inputBytes)));
      if (req.method === 'POST' && parts.length === 5 && parts[2] === 'sessions' && parts[4] === 'turns') return json(res, 202, await service.submit(parts[3], await readBody(req, service.limits.inputBytes)));
      if (parts[2] === 'turns' && parts[3]) {
        if (req.method === 'GET' && parts.length === 4) return json(res, 200, service.status(parts[3]));
        if (req.method === 'GET' && parts.length === 5 && parts[4] === 'events') {
          const raw = url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '0';
          check(typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw), 'invalid_event_cursor');
          return await streamEvents(service, parts[3], Number(raw), req, res);
        }
        if (req.method === 'POST' && parts.length === 5 && parts[4] === 'cancel') return json(res, 200, await service.cancel(parts[3]));
        if (req.method === 'POST' && parts.length === 6 && parts[4] === 'approvals') return json(res, 200, await service.approve(parts[3], parts[5], await readBody(req, service.limits.inputBytes)));
      }
      throw new BridgeError('not_found', 404);
    } catch (e) {
      const disk=storage.storageErrorDetails(e);
      if(disk)e=Object.assign(new BridgeError('node_storage_full',507),{storageDetails:disk});
      const status=e instanceof BridgeError?e.status:500;
      const type=status>=500?'server_error':'invalid_request_error';
      if(status>=500){try{console.error(JSON.stringify({scope:'workbaby-http',at:new Date().toISOString(),code:e.code??'internal_error',errorName:e.name,requestId:res.getHeader('X-Request-Id'),...publicErrorDetails(e)}));}catch{}}
      if (res.headersSent && openAiRoute && !res.destroyed) {
        const code=e instanceof BridgeError?e.code:'internal_error';
        res.end(`data: ${JSON.stringify({error:{message:code,type:'upstream_error',code,status,...safeUpstreamDetails(e.upstream),...publicErrorDetails(e)}})}\n\n`);
      }
      else if (res.headersSent) res.destroy();
      else if (openAiRoute) json(res, status, { error: { message: e instanceof BridgeError ? e.code : 'internal_error', type, code: e instanceof BridgeError ? e.code : 'internal_error', ...safeUpstreamDetails(e.upstream),...publicErrorDetails(e) } });
      else json(res, e instanceof BridgeError ? e.status : 500, { error: e instanceof BridgeError ? e.code : 'internal_error' });
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/workbaby/v1`,
    async close() { for (const res of readers) res.destroy(); await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  };
}
