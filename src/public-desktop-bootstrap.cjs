const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Module = require('node:module');
const profile = require('./public-desktop-profile.json');
const { createProductGeneration } = require('./product-identity.cjs');

function install(config) {
  const archive = path.join(config.officialRoot, 'resources', 'app.asar');
  for (const [name, expected] of Object.entries(profile.files)) {
    if (createHash('sha256').update(fs.readFileSync(path.join(archive, name))).digest('hex') !== expected)
      throw Error('official_fingerprint_mismatch');
  }

  const target = path.join(archive, 'main', 'server.js');
  const originalLoad = Module._load;
  let wrapped;
  Module._load = function (request, parent, isMain) {
    const exports = Reflect.apply(originalLoad, this, arguments);
    let file;
    try { file = Module._resolveFilename(request, parent, isMain); }
    catch { return exports; }
    if (file !== target) return exports;
    if (wrapped) return wrapped;

    const keys = Object.keys(exports).filter(key => typeof exports[key] === 'function' &&
      Function.prototype.toString.call(exports[key]).includes(profile.bootstrapMarker));
    if (keys.length !== 1) {
      process.stderr.write('[workbaby-public] official_bootstrap_boundary_changed\n');
      return exports;
    }
    const [key] = keys;
    const original = exports[key];
    let mount;
    async function start(...args) {
      const daemon = await Reflect.apply(original, this, args);
      mount ??= attach(daemon, args[0], config).catch(() => {
        process.stderr.write('[workbaby-public] native_bridge_mount_failed\n');
      });
      await mount;
      return daemon;
    }
    wrapped = new Proxy(exports, {
      get(object, name, receiver) { return name === key ? start : Reflect.get(object, name, receiver); }
    });
    return wrapped;
  };
}

async function attach(daemon, official, config) {
  const { mountNativeBridge } = await import('./public-native.mjs');
  const boot = randomUUID();
  const productGeneration = createProductGeneration(official.celljs?.productManager);
  const { sessionManager } = daemon;
  let bridge;
  try {
    bridge = await mountNativeBridge({
      daemon,
      dataRoot: config.dataRoot,
      allowedWorkspaces: config.allowedWorkspaces,
      port: config.port,
      token: fs.readFileSync(config.tokenFile, 'utf8').trim(),
      getIdentity() {
        const ownerId = sessionManager.getCurrentUserId?.();
        const generation = sessionManager.historyOwnerGeneration;
        if (!ownerId || !Number.isSafeInteger(generation))
          throw Object.assign(Error('official_login_required'), { code: 'official_login_required' });
        return { instanceId: config.instanceId, ownerId, realm: profile.realm,
          generation: `${boot}:${generation}:${productGeneration.get()}` };
      }
    });
    fs.writeFileSync(config.registry, JSON.stringify({ pid: process.pid, url: bridge.url }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    try { await bridge?.close(); }
    finally { productGeneration.dispose(); }
    throw error;
  }
  if (typeof daemon.stop === 'function') {
    const originalStop = daemon.stop;
    daemon.stop = async function (...args) {
      try { return await Reflect.apply(originalStop, this, args); }
      finally {
        try { await bridge.close(); }
        catch { process.stderr.write('[workbaby-public] native_bridge_shutdown_pending\n'); }
        finally { productGeneration.dispose(); }
      }
    };
  }
}

exports.prepareDesktopMenu = configFile => {
  const { officialRoot } = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  require('./desktop-community.mjs').preparePublicDesktopCommunity(require('electron'), officialRoot);
};

if (process.env.WORKBABY_PUBLIC_LAUNCH_CONFIG && /[\\/]daemon-app-server-entry\.js$/.test(process.argv[1] ?? '')) {
  try { install(JSON.parse(fs.readFileSync(process.env.WORKBABY_PUBLIC_LAUNCH_CONFIG, 'utf8'))); }
  catch { process.stderr.write('[workbaby-public] official_fingerprint_or_config_invalid\n'); }
}
