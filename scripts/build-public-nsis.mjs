import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pipeline } from 'node:stream/promises';

const source = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  output: { type: 'string' },
  makensis: { type: 'string' },
  'local-workbuddy-root': { type: 'string' },
  'local-runtime-archive': { type: 'string' },
  'local-runtime-sha256': { type: 'string' },
  'local-extractor-root': { type: 'string' }
} });
if (process.platform !== 'win32') throw Error('Build the Windows setup with NSIS 3.12 on Windows.');
const compiler = values.makensis ?? process.env.NSIS_PATH ??
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'NSIS', 'makensis.exe');
const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Expected an NSIS-compatible package version.');
const runtimeInput = values['local-workbuddy-root'];
const variant = runtimeInput ? 'offline-' : '';
const output = path.resolve(values.output ?? path.join(source, 'dist', `workbuddy-pangpangxiong-${version}-${variant}setup.exe`));
if (path.extname(output).toLowerCase() !== '.exe' || fs.existsSync(output)) throw Error('Choose a new .exe output path.');
const compilerVersion = execFileSync(compiler, ['/VERSION'], { encoding: 'utf8', windowsHide: true }).trim();
if (compilerVersion !== 'v3.12') throw Error('Use NSIS 3.12 to reproduce the release build.');

const files = JSON.parse(fs.readFileSync(path.join(source, 'installer/public-files.json'), 'utf8'));
if (new Set(files).size !== files.length) throw Error('The installer file list contains duplicate paths.');
const directories = new Set();
const install = ['!macro PublicInstallFiles'];
const uninstall = ['!macro PublicRemoveFiles'];
const quote = value => value.replaceAll('$', () => '$$').replaceAll('"', '$\\"');
for (const entry of files) {
  if (!/^(?:(?:src|scripts|scripts\/lib|installer)\/)?[A-Za-z0-9._-]+$/.test(entry) || entry.includes('..'))
    throw Error('Unexpected installer file path.');
  const local = path.join(source, entry);
  if (!fs.lstatSync(local).isFile()) throw Error('Installer inputs must be regular files.');
  const directory = path.win32.dirname(entry.replaceAll('/', '\\'));
  install.push(`  SetOutPath "$INSTDIR${directory === '.' ? '' : '\\' + directory}"`);
  install.push(`  File /oname=${path.win32.basename(entry)} "${quote(local)}"`);
  uninstall.push(`  Delete "$INSTDIR\\${entry.replaceAll('/', '\\')}"`);
  for (let folder = directory; folder !== '.'; folder = path.win32.dirname(folder)) directories.add(folder.replaceAll('/', '\\'));
}
for (const directory of [...directories].sort((a, b) => b.length - a.length))
  uninstall.push(`  RMDir "$INSTDIR\\${directory}"`);
install.push('!macroend');
uninstall.push('!macroend');

const offline = [];
const defines = [];
let offlineFiles = 0;
let localArchive;
if (runtimeInput) {
  const { checkOfficial } = await import('./public-desktop.mjs');
  const official = checkOfficial(runtimeInput);
  const expected = values['local-runtime-sha256'];
  if (!values['local-runtime-archive'] || !values['local-extractor-root'] || !/^[0-9a-f]{64}$/.test(expected ?? ''))
    throw Error('Supply the verified local 7z payload, SHA-256 and the local 7-Zip tool directory.');
  localArchive = fs.realpathSync(values['local-runtime-archive']);
  const size = fs.statSync(localArchive).size;
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(localArchive)) digest.update(chunk);
  if (digest.digest('hex') !== expected) throw Error('The local WorkBuddy archive differs from its verified SHA-256.');
  const tools = fs.realpathSync(values['local-extractor-root']);
  const unpacker = ['7z.exe', '7z.dll', 'License.txt'].map(name => path.join(tools, name));
  if (!unpacker.every(file => fs.lstatSync(file).isFile())) throw Error('The local 7-Zip tool files are incomplete.');
  const runtimeDirectories = [];
  offline.push('!macro OfflineInstallRuntime', '  InitPluginsDir', '  SetOutPath "$PLUGINSDIR"');
  for (const tool of unpacker) offline.push(`  File "${quote(tool)}"`);
  offline.push(`  File /oname=extract-local-runtime.mjs "${quote(path.join(source, 'scripts/lib/extract-local-runtime.mjs'))}"`,
    `  nsExec::ExecToStack /TIMEOUT=180000 '"$NodeExe" "$PLUGINSDIR\\extract-local-runtime.mjs" "$EXEPATH" "$INSTDIR\\WorkBuddyAI" "$PLUGINSDIR\\7z.exe" ${size} ${expected}'`,
    '  Pop $1', '  Pop $2', '  DetailPrint $2', '  StrCmp $1 "0" +2', '  SetErrors',
    '!macroend', '!macro OfflineRemoveRuntime');
  const visit = folder => {
    const base = path.join(official, folder);
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const relative = path.join(folder, entry.name);
      if (entry.isSymbolicLink() || /^(?:accounts|service-token|debug\.log|workbaby-management(?:\.json|-token)?)$/i.test(entry.name) ||
          (/\.bak$/i.test(entry.name) && relative !== 'ffmpeg.dll.bak')) {
        throw Error('The offline payload must be a clean official extraction.');
      }
      if (entry.isDirectory()) {
        runtimeDirectories.push(relative);
        visit(relative);
      } else if (entry.isFile()) {
        offline.push(`  Delete "$INSTDIR\\WorkBuddyAI\\${quote(relative)}"`);
        offlineFiles++;
      } else throw Error('Unsupported offline payload file type.');
    }
  };
  visit('');
  for (const directory of runtimeDirectories.reverse())
    offline.push(`  RMDir "$INSTDIR\\WorkBuddyAI\\${quote(directory)}"`);
  offline.push('  RMDir "$INSTDIR\\WorkBuddyAI"', '!macroend');
  defines.push('/DLOCAL_OFFLINE_BUNDLE');
}

const temporaryRoot = fs.realpathSync(os.tmpdir());
const stage = fs.mkdtempSync(path.join(temporaryRoot, 'workbuddy-nsis-'));
try {
  const include = path.join(stage, 'payload.nsh');
  fs.writeFileSync(include, [...install, '', ...uninstall, '', ...offline, ''].join('\r\n'), { encoding: 'utf8', flag: 'wx' });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(compiler, [
    '/NOCD', '/V2', '/WX', '/INPUTCHARSET', 'UTF8', `/DPUBLIC_PAYLOAD=${quote(include)}`,
    `/DPUBLIC_OUTPUT=${quote(output)}`, `/DPUBLIC_VERSION=${version}`, ...defines, path.join(source, 'installer/workbuddy-public.nsi')
  ], { cwd: source, stdio: 'inherit', windowsHide: true });
  if (localArchive) await pipeline(fs.createReadStream(localArchive), fs.createWriteStream(output, { flags: 'a' }));
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(output)) digest.update(chunk);
  console.log(JSON.stringify({ version, compilerVersion, bytes: fs.statSync(output).size, files: files.length,
    ...(runtimeInput ? { offlineFiles } : {}), sha256: digest.digest('hex'), output }));
} finally {
  if (path.dirname(fs.realpathSync(stage)) === temporaryRoot && path.basename(stage).startsWith('workbuddy-nsis-'))
    fs.rmSync(stage, { recursive: true });
}
