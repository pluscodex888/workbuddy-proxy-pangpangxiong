import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

async function main() {
  const [installer, output, extractor, sizeText, expected] = process.argv.slice(2);
  const size = Number(sizeText);
  if (!path.isAbsolute(installer ?? '') || !path.isAbsolute(output ?? '') || !path.isAbsolute(extractor ?? '') ||
      path.basename(output) !== 'WorkBuddyAI' || !Number.isSafeInteger(size) || size < 1024 ||
      !/^[0-9a-f]{64}$/.test(expected ?? '')) throw Error('Invalid offline installer extraction inputs.');
  const offset = fs.statSync(installer).size - size;
  if (offset <= 0 || offset > 4 * 1024 * 1024) throw Error('Invalid embedded WorkBuddy payload offset.');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(installer, { start: offset })) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw Error('Embedded WorkBuddy payload checksum did not match.');

  const result = execFileSync(extractor, ['l', '-t7z', '-slt', '-sccUTF-8', installer], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024
  });
  const layout = result.split(/\r?\n/);
  if (!layout.includes('Offset = ' + offset) || !layout.includes('Physical Size = ' + size))
    throw Error('The embedded archive does not match the verified installer tail.');
  fs.mkdirSync(output, { recursive: true });
  execFileSync(extractor, ['x', '-t7z', '-y', '-aoa', '-bso0', '-bsp0', '-o' + output, installer], {
    windowsHide: true
  });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
