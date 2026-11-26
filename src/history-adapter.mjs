import { check, digest, canonical, BridgeError } from './contracts.mjs';

/** Lossless external snapshot plus conservative native projection. Unsupported
 * semantic roles must not masquerade as user text. Broken display items can be
 * skipped, but tools are admitted only as adjacent, explicitly matched pairs. */
export function projectHistory(items, { rich = false } = {}) {
  check(Array.isArray(items), 'invalid_history');
  const projection = [], skipped = [], idMap = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object' || typeof item.role !== 'string') { skipped.push({ index: i, reason: 'malformed_display_item' }); continue; }
    if (rich) {
      if (['system', 'user', 'assistant'].includes(item.role)) {
        const content = item.content;
        check(typeof content === 'string' || Array.isArray(content), 'rich_content_required', 422);
        if (Array.isArray(content)) for (const block of content) {
          check(block && typeof block === 'object' && typeof block.type === 'string', 'rich_content_block_invalid', 422);
          const allowed = item.role === 'user' ? ['input_text','input_image','input_file','input_audio'] : item.role === 'assistant' ? ['output_text','refusal'] : ['input_text','output_text'];
          check(allowed.includes(block.type), 'rich_content_block_unsupported', 422);
          if (['input_text','output_text','refusal'].includes(block.type)) check(typeof block.text === 'string', 'rich_content_text_required', 422);
        }
        projection.push(structuredClone(item)); continue;
      }
      if (item.role === 'developer') {
        const content = item.content; check(typeof content === 'string' || Array.isArray(content), 'rich_content_required', 422);
        if (Array.isArray(content)) for (const block of content) check(block?.type === 'input_text' && typeof block.text === 'string', 'rich_developer_content_unsupported', 422);
        projection.push(structuredClone(item)); continue;
      }
      if (item.role === 'reasoning') {
        check(Array.isArray(item.content) && item.content.every(b => b && typeof b.text === 'string'), 'rich_reasoning_invalid', 422);
        projection.push(structuredClone(item)); continue;
      }
      if (item.role === 'tool_call') {
        const callId = item.callId ?? item.id; check(typeof callId === 'string' && callId.length > 0, 'rich_tool_call_id_required', 422);
        let args = item.arguments; if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw new BridgeError('rich_tool_arguments_invalid', 422); } }
        check(args && typeof args === 'object' && !Array.isArray(args) && typeof item.name === 'string' && item.name.length > 0, 'rich_tool_call_invalid', 422);
        projection.push(structuredClone({ ...item, callId, arguments: args })); idMap.push({ externalCallId: callId, projectedIndex: projection.length - 1, nativeCallId: null }); continue;
      }
      if (item.role === 'tool_result') {
        const callId = item.callId ?? item.tool_call_id; check(typeof callId === 'string' && callId.length > 0, 'rich_tool_result_id_required', 422);
        const output = item.output ?? item.content; check(typeof output === 'string' || Array.isArray(output), 'rich_tool_result_invalid', 422);
        projection.push(structuredClone({ ...item, callId, ...(item.output === undefined ? { output } : {}) })); continue;
      }
      skipped.push({ index: i, type: item.role, reason: 'unknown_display_role' }); continue;
    }
    if (['system', 'developer'].includes(item.role)) throw new BridgeError('rich_history_required', 422);
    if (['user', 'assistant'].includes(item.role)) {
      const content = typeof item.content === 'string' ? item.content : Array.isArray(item.content) && item.content.every(b => b?.type === 'text' && typeof b.text === 'string') ? item.content.map(b => b.text).join('') : null;
      check(content !== null, 'history_media_not_supported', 422);
      projection.push({ role: item.role, content }); continue;
    }
    if (item.role === 'tool_call') {
      const result = items[i + 1];
      const callId = item.callId ?? item.id;
      check(typeof callId === 'string' && callId.length && result?.role === 'tool_result' && (result.callId ?? result.tool_call_id) === callId, 'history_tool_pair_requires_rich_adapter', 422);
      let args = item.arguments;
      try { if (typeof args === 'string') args = JSON.parse(args); } catch { args = null; }
      if (!args || typeof args !== 'object' || Array.isArray(args) || typeof item.name !== 'string' || typeof (result.output ?? result.content) !== 'string') {
        skipped.push({ index: i, pairedIndex: i + 1, reason: 'malformed_tool_pair' }); i++; continue;
      }
      // Native simple import regenerates IDs; report the mapping limitation explicitly.
      idMap.push({ externalCallId: callId, projectedIndex: projection.length, nativeCallId: null });
      projection.push({ role: 'tool_call', name: item.name, arguments: args }, { role: 'tool_result', output: result.output ?? result.content }); i++; continue;
    }
    check(item.role !== 'tool_result', 'orphan_tool_result', 422);
    skipped.push({ index: i, type: item.role, reason: 'unknown_display_role' });
  }
  return { source: structuredClone(items), projection, skipped, idMap };
}

export function planHistory(session, body, options) {
  if (body.history === undefined) return null;
  check(['snapshot', 'delta'].includes(body.historyMode), 'history_mode_required');
  check(Number.isSafeInteger(body.historyRevision) && body.historyRevision > session.historyRevision, 'history_revision_conflict', 409);
  const old = session.historySource ?? [];
  let source;
  if (body.historyMode === 'snapshot') {
    check(Array.isArray(body.history) && body.history.length >= old.length && canonical(body.history.slice(0, old.length)) === canonical(old), 'history_prefix_conflict', 409);
    source = body.history;
  } else {
    check(body.baseHistoryRevision === session.historyRevision, 'history_base_revision_conflict', 409);
    check(Array.isArray(body.history), 'invalid_history'); source = [...old, ...body.history];
  }
  const full = projectHistory(source, options), previous = projectHistory(old, options);
  return { ...full, delta: full.projection.slice(previous.projection.length), deltaStart: previous.projection.length, revision: body.historyRevision, digest: digest(source) };
}

/** The port must read actual CLI items, strictly bound to this session. A count
 * from inject_history is never accepted as proof. Partial imports are recovered
 * by reading a prefix, not replaying the entire history. */
export async function importHistory(port, sessionId, plan, intent, persistIntent) {
  check(port.historyVerified === true, 'history_readback_unverified', 422);
  let current = await port.readHistory(sessionId);
  check(current.sessionId === sessionId && current.idle === true, 'history_target_not_idle');
  if (!intent) {
    intent = { baseline: current.items, delta: plan.delta, revision: plan.revision };
    persistIntent(intent);
  }
  const expected = [...intent.baseline, ...intent.delta];
  check(current.items.length >= intent.baseline.length && current.items.length <= expected.length && canonical(current.items) === canonical(expected.slice(0, current.items.length)), 'history_readback_diverged');
  while (current.items.length < expected.length) {
    let end = current.items.length + 1;
    if (expected[current.items.length].role === 'tool_call') end++;
    await port.injectHistory(sessionId, expected.slice(current.items.length, end));
    const next = await port.readHistory(sessionId);
    check(next.sessionId === sessionId && next.idle && next.items.length === end && canonical(next.items) === canonical(expected.slice(0, end)), 'history_readback_mismatch');
    current = next;
  }
  const idMap=(plan.idMap??[]).filter(x=>x.projectedIndex>=(plan.deltaStart??0)).map(x=>{
    const actual=current.nativeIds?.[intent.baseline.length+x.projectedIndex-(plan.deltaStart??0)];
    return {...x,nativeCallId:actual?.callId??null,nativeItemId:actual?.id??null};
  });
  return { imported: plan.delta.length, digest: plan.digest, idMap, persisted: current.persisted === true };
}
