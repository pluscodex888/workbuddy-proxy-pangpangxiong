const types = {
  agent_message_chunk: 'message.delta', assistant_message_chunk: 'message.delta',
  agent_thought_chunk: 'reasoning.delta', tool_call: 'tool.call', tool_call_update: 'tool.update',
  permissionRequest: 'approval.required', questionRequest: 'question.required', elicitationRequest: 'question.required',
  'session/request_permission': 'approval.required', usage: 'usage', artifact: 'artifact'
};
export function normalizeEvent(raw) {
  const body = raw.payload ?? raw, update = body.update ?? body;
  return { type: types[update.sessionUpdate ?? body.type ?? raw.channel] ?? 'native.event', payload: raw };
}
export function outcome(result, state, observed) {
  const stopReason = result?.stopReason;
  if (stopReason === 'cancelled') return { state: 'cancelled', stopReason };
  const businessError = result?.error || result?.isError || result?._meta?.['codebuddy.ai']?.error || observed.businessError || ['failed', 'error'].includes(state?.status);
  if (businessError || observed.toolFailed) return { state: 'failed', reason: 'native_business_or_tool_error', stopReason: stopReason ?? null };
  if (stopReason !== 'end_turn') return { state: 'incomplete', reason: stopReason ?? 'missing_stop_reason', stopReason: stopReason ?? null };
  if (!state || state.isProcessing || state.hasActiveToolCalls || state.hasActiveTeamMembers || ['planning','working','pending','terminated','archived'].includes(state.status) || state.pendingPermissions?.length || state.pendingQuestions?.length || state.pendingElicitations?.length || observed.pendingTools.size) {
    return { state: 'incomplete', reason: 'native_pending_work', stopReason };
  }
  return { state: 'completed', stopReason };
}
