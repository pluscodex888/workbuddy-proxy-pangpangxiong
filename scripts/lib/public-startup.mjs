export async function configureDedicatedChild(endpoint, preload, config) {
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/i.test(endpoint)) throw Error('invalid_startup_endpoint');
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  const pending = new Map();
  let paused;
  const onPause = new Promise(resolve => { paused = resolve; });
  const deadline = AbortSignal.timeout(12000);
  const abort = () => {
    for (const { reject } of pending.values()) reject(Error('startup_connection_closed'));
    pending.clear();
    paused(false);
  };
  socket.addEventListener('close', abort);
  deadline.addEventListener('abort', () => { abort(); socket.close(); }, { once: true });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Debugger.paused') paused(true);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(Error('startup_command_failed'));
    else request.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    if (deadline.aborted || socket.readyState !== WebSocket.OPEN) return reject(Error('startup_connection_closed'));
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(Error('startup_connection_failed')), { once: true });
      socket.addEventListener('close', () => reject(Error('startup_connection_closed')), { once: true });
    });
    await command('Runtime.enable');
    await command('Debugger.enable');
    await command('Runtime.runIfWaitingForDebugger');
    if (!await onPause) throw Error('startup_pause_unavailable');
    const normalized = preload.replaceAll('\\', '/');
    const option = `--require="${normalized}"`;
    const result = await command('Runtime.evaluate', {
      expression: `process.env.NODE_OPTIONS = ${JSON.stringify(option)}; process.env.WORKBABY_PUBLIC_LAUNCH_CONFIG = ${JSON.stringify(config)}; process.getBuiltinModule('node:module').createRequire(${JSON.stringify(config)})(${JSON.stringify(normalized)}).prepareDesktopMenu(${JSON.stringify(config)}); setImmediate(() => process.getBuiltinModule('node:inspector').close()); true`,
      returnByValue: true
    });
    if (result.exceptionDetails || result.result?.value !== true) throw Error('startup_configuration_failed');
    await command('Debugger.resume');
  } finally {
    socket.close();
  }
}
