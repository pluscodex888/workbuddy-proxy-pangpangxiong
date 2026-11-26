import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const source = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  output: { type: 'string' },
  makensis: { type: 'string' }
} });
if (process.platform !== 'win32') throw Error('Build the Windows setup with NSIS 3.12 on Windows.');
const compiler = values.makensis ?? process.env.NSIS_PATH ??
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'NSIS', 'makensis.exe');
const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Expected an NSIS-compatible package version.');
const output = path.resolve(values.output ?? path.join(source, 'dist', `workbuddy-pangpangxiong-${version}-setup.exe`));
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

const temporaryRoot = fs.realpathSync(os.tmpdir());
const stage = fs.mkdtempSync(path.join(temporaryRoot, 'workbuddy-nsis-'));
try {
  const include = path.join(stage, 'payload.nsh');
  fs.writeFileSync(include, [...install, '', ...uninstall, ''].join('\r\n'), { encoding: 'utf8', flag: 'wx' });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(compiler, [
    '/NOCD', '/V2', '/WX', '/INPUTCHARSET', 'UTF8', `/DPUBLIC_PAYLOAD=${quote(include)}`,
    `/DPUBLIC_OUTPUT=${quote(output)}`, `/DPUBLIC_VERSION=${version}`, path.join(source, 'installer/workbuddy-public.nsi')
  ], { cwd: source, stdio: 'inherit', windowsHide: true });
  const binary = fs.readFileSync(output);
  console.log(JSON.stringify({ version, compilerVersion, bytes: binary.length, files: files.length,
    sha256: createHash('sha256').update(binary).digest('hex'), output }));
} finally {
  if (path.dirname(fs.realpathSync(stage)) === temporaryRoot && path.basename(stage).startsWith('workbuddy-nsis-'))
    fs.rmSync(stage, { recursive: true });
}
