import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readAsar, readFuses } from './lib/asar.mjs';
import { privateRuntime } from './lib/private-runtime.mjs';
import { configureDedicatedChild } from './lib/public-startup.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const profile = read(path.join(source, 'src/public-desktop-profile.json'));
const installationManifest = path.join(source, 'installer/public-files.json');
const schema = 'workbaby.public-install/v1';
const executable = 'WorkBuddyAI.exe';

function absolute(value, field) {
  const input = value?.trim().replace(/^"(.*)"$/, '$1');
  if (!input || !path.isAbsolute(input)) throw Error(field + '_must_be_absolute');
  return path.resolve(input);
}

function overlaps(one, other) {
  const relative = (from, to) => path.relative(from, to);
  const inside = value => value === '' || (!path.isAbsolute(value) && value !== '..' && !value.startsWith('..' + path.sep));
  return inside(relative(one, other)) || inside(relative(other, one));
}

export function checkOfficial(directory) {
  let official = absolute(directory, 'workbuddy_root');
  if (path.basename(official).toLowerCase() === executable.toLowerCase()) official = path.dirname(official);
  official = fs.realpathSync(official);
  const archive = path.join(official, 'resources/app.asar');
  for (const [name, expected] of Object.entries(profile.files)) {
    if (createHash('sha256').update(readAsar(archive, name)).digest('hex') !== expected)
      throw Error('unsupported_workbuddy_installation_expected_' + profile.version);
  }
  if (readFuses(path.join(official, executable)).nodeOptions !== '1') throw Error('workbuddy_preload_unavailable');
  return official;
}

function getHome(option) {
  if (process.platform !== 'win32') throw Error('windows_required_for_desktop_installation');
  const home = absolute(option ?? path.join(process.env.LOCALAPPDATA ?? '', 'WorkBuddyPangPangXiong'), 'home');
  if (home === path.parse(home).root || (overlaps(home, source) &&
    home !== path.dirname(path.resolve(source)))) throw Error('choose_a_dedicated_install_directory');
  if (fs.existsSync(home) && fs.lstatSync(home).isSymbolicLink()) throw Error('install_directory_is_link');
  return home;
}

function loadConfig(home) {
  const config = read(path.join(home, 'config.json'));
  if (config.schema !== schema || !/^[a-f0-9-]{36}$/i.test(config.instanceId) ||
    !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw Error('invalid_install_config');
  return { ...config, officialRoot: absolute(config.officialRoot, 'workbuddy_root'), workspace: absolute(config.workspace, 'workspace') };
}

function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function writeJson(target, data) {
  const next = target + '.' + randomUUID();
  fs.writeFileSync(next, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(next, target);
}

function readLaunch(home) {
  const record = path.join(home, 'launch.json');
  return fs.existsSync(record) ? read(record) : null;
}

async function setup(home, options) {
  const existing = fs.existsSync(path.join(home, 'config.json')) ? loadConfig(home) : null;
  const marker = path.join(home, 'install-root.json');
  const initialized = fs.existsSync(marker) && read(marker).schema === schema;
  if (!existing && !initialized && fs.readdirSync(home).some(name => name !== 'setup-start.lock'))
    throw Error('choose_an_empty_install_directory');
  if (ownerAlive(readLaunch(home)?.pid)) throw Error('close_this_assistant_before_configuring');
  let official = options['workbuddy-root'] ?? existing?.officialRoot;
  if (!official) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { official = await input.question('WorkBuddyAI.exe or its installation folder: '); }
    finally { input.close(); }
  }
  official = checkOfficial(official);
  const workspace = absolute(options.workspace ?? existing?.workspace ?? path.join(home, 'workspace'), 'workspace');
  const defaultWorkspace = workspace === path.join(home, 'workspace');
  if (overlaps(home, official) || overlaps(official, workspace) || (!defaultWorkspace && overlaps(home, workspace)))
    throw Error('workbuddy_installation_workspace_and_state_must_be_separate');
  const rawPort = options.port ?? existing?.port ?? '0';
  const port = Number(rawPort);
  if (!/^\d{1,5}$/.test(String(rawPort)) || port > 65535) throw Error('port_must_be_between_0_and_65535');

  if (fs.realpathSync(home).toLowerCase() !== home.toLowerCase()) throw Error('install_path_resolves_to_another_location');
  if (fs.existsSync(workspace)) ensureWorkspace(home, { workspace }, official);
  privateRuntime(home);
  if (!initialized) writeJson(marker, { schema });
  fs.mkdirSync(workspace, { recursive: true });
  const tokenFile = path.join(home, 'service-token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  const settings = { schema, officialRoot: official, workspace, port, instanceId: existing?.instanceId ?? randomUUID() };
  const candidates = read(installationManifest).map(name => {
    if (!/^(?:(?:src|scripts|scripts\/lib|installer)\/)?[A-Za-z0-9._-]+$/.test(name) || name.includes('..'))
      throw Error('invalid_install_manifest');
    return { name, bytes: fs.readFileSync(path.join(source, name)) };
  });
  let program = /^program-[a-f0-9-]{36}$/i.test(existing?.program ?? '')
    ? path.join(home, existing.program) : null;
  if (!program || !fs.existsSync(program) || fs.lstatSync(program).isSymbolicLink() ||
      !candidates.every(({ name, bytes }) => fs.existsSync(path.join(program, name)) && fs.readFileSync(path.join(program, name)).equals(bytes))) {
    program = path.join(home, 'program-' + randomUUID());
    for (const { name, bytes } of candidates) {
      const target = path.join(program, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
  }
  writeJson(path.join(home, 'config.json'), { ...settings, program: path.basename(program) });
  const installedStart = path.join(program, 'Start.cmd');
  console.log(JSON.stringify({ configured: true, version: profile.version, config: path.join(home, 'config.json'), start: installedStart }));
}

function ensureWorkspace(home, config, official) {
  const workspace = fs.realpathSync(config.workspace);
  if (!fs.statSync(workspace).isDirectory() || overlaps(official, workspace) ||
    (overlaps(home, workspace) && workspace.toLowerCase() !== path.join(home, 'workspace').toLowerCase()))
    throw Error('workspace_is_unavailable_or_overlaps_configuration');
  return workspace;
}

function safeRegistry(file) {
  const record = read(file);
  const url = new URL(record.url);
  if (!/^http:\/\/127\.0\.0\.1:\d+\/workbaby\/v1$/.test(url.href) || !ownerAlive(record.pid)) throw Error('invalid_bridge_registry');
  return record;
}

async function getStatus(home) {
  const launch = readLaunch(home);
  if (!ownerAlive(launch?.pid) || !/^[a-f0-9-]{36}$/i.test(launch.run)) throw Error('assistant_is_not_running');
  const record = safeRegistry(path.join(home, 'startup', launch.run, 'instance.json'));
  const token = fs.readFileSync(path.join(home, 'service-token'), 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('invalid_service_token_file');
  const result = await fetch(record.url + '/capabilities', {
    headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(4000)
  });
  const body = await result.json();
  if (result.status === 401 && body.error === 'official_login_required') return { url: record.url, status: 'official_login_required' };
  if (result.status !== 200 || body.native !== true || body.raw !== false) throw Error('bridge_status_unavailable');
  return { url: record.url, status: 'ready' };
}

async function start(home, config) {
  if (ownerAlive(readLaunch(home)?.pid)) return getStatus(home);
  const official = checkOfficial(config.officialRoot);
  if (overlaps(home, official)) throw Error('workbuddy_installation_must_be_separate');
  const workspace = ensureWorkspace(home, config, official);
  const run = randomUUID();
  const startup = path.join(home, 'startup', run);
  const data = path.join(home, 'state');
  const configFile = path.join(startup, 'launch-config.json');
  const registry = path.join(startup, 'instance.json');
  for (const name of [startup, ...['config', 'app', 'bridge', 'temp'].map(x => path.join(data, x))])
    fs.mkdirSync(name, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(home, 'service-token');
  if (!/^[a-f0-9]{64}$/.test(fs.readFileSync(tokenFile, 'utf8').trim())) throw Error('invalid_service_token_file');
  writeJson(configFile, { officialRoot: official, dataRoot: path.join(data, 'bridge'), tokenFile,
    port: config.port, instanceId: config.instanceId, registry, allowedWorkspaces: [workspace] });

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:WORKBUDDY_|WORKBABY_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    WORKBUDDY_CONFIG_DIR: path.join(data, 'config'), WORKBUDDY_DATA_DIR: path.join(data, 'config'),
    WORKBUDDY_USER_DATA_DIR: path.join(data, 'app'), WORKBUDDY_INSTALL_DIR: official,
    WORKBUDDY_RESOURCES_PATH: path.join(official, 'resources'), TEMP: path.join(data, 'temp'), TMP: path.join(data, 'temp')
  });
  const stderrPath = path.join(startup, 'desktop-stderr.log');
  const stderr = fs.openSync(stderrPath, 'wx', 0o600);
  const stdout = fs.openSync(path.join(startup, 'desktop-stdout.log'), 'wx', 0o600);
  let child;
  try {
    child = spawn(path.join(official, executable), [
      '--inspect-brk=127.0.0.1:0', '--user-data-dir=' + path.join(data, 'app')
    ], { cwd: data, env, windowsHide: false, detached: true, stdio: ['ignore', stdout, stderr] });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  try {
    writeJson(path.join(home, 'launch.json'), { pid: child.pid, run });
    const deadline = Date.now() + 15000;
    let endpoint;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error('dedicated_workbuddy_exited');
      endpoint = fs.readFileSync(stderrPath, 'utf8').match(/^Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)$/im)?.[1];
      if (endpoint) break;
      await delay(50);
    }
    if (!endpoint) throw Error('dedicated_startup_endpoint_unavailable');
    await configureDedicatedChild(endpoint, path.join(source, 'src/public-desktop-bootstrap.cjs'), configFile);
    const readiness = Date.now() + 45000;
    while (!fs.existsSync(registry) && Date.now() < readiness) {
      if (child.exitCode !== null) throw Error('dedicated_workbuddy_exited');
      await delay(150);
    }
    if (!fs.existsSync(registry)) throw Error('native_bridge_startup_timeout');
    return await getStatus(home);
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  } finally { child.unref(); }
}

async function main() {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 16)) throw Error('Node.js 22.16 or newer is required');
  const [command, ...args] = process.argv.slice(2);
  if (!['install', 'start', 'status', 'check'].includes(command))
    throw Error('usage: public-desktop.mjs install|start|status|check [--home path] [--workbuddy-root path] [--workspace path] [--port 0]');
  const { values } = parseArgs({ args, options: {
    home: { type: 'string' }, 'workbuddy-root': { type: 'string' }, workspace: { type: 'string' }, port: { type: 'string' }
  } });
  if (command === 'check') {
    checkOfficial(values['workbuddy-root']);
    console.log(JSON.stringify({ officialStaticMatch: true, version: profile.version }));
    return;
  }
  const home = getHome(values.home);
  if (command === 'status') return console.log(JSON.stringify(await getStatus(home)));
  if (command === 'start') {
    if (!fs.existsSync(path.join(home, 'config.json'))) throw Error('run_Install_cmd_first');
    const config = loadConfig(home);
    if (!/^program-[a-f0-9-]{36}$/i.test(config.program)) throw Error('invalid_installed_program');
    const installed = fs.realpathSync(path.join(home, config.program));
    if (path.dirname(installed).toLowerCase() !== home.toLowerCase()) throw Error('unsafe_installed_program_directory');
    if (path.resolve(source).toLowerCase() !== installed.toLowerCase()) {
      const child = spawn(process.execPath, [path.join(installed, 'scripts/public-desktop.mjs'), 'start', '--home', home], {
        stdio: 'inherit', windowsHide: true
      });
      return await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => { process.exitCode = code ?? 1; resolve(); });
      });
    }
  }
  if (command === 'install' && !fs.existsSync(home)) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, 'setup-start.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    if (command === 'install') await setup(home, values);
    else console.log(JSON.stringify(await start(home, loadConfig(home))));
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
