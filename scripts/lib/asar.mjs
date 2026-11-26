import fs from 'node:fs';
import path from 'node:path';

/** Read only selected ASAR entries; never extract/hash the whole application. */
export function readAsar(file, name) {
  const fd = fs.openSync(file, 'r');
  try {
    const lead = Buffer.alloc(16); fs.readSync(fd, lead, 0, 16, 0);
    const headerBytes = lead.readUInt32LE(4), jsonBytes = lead.readUInt32LE(12);
    if (jsonBytes > 32 * 1024 * 1024 || jsonBytes + 8 > headerBytes) throw new Error('invalid_asar_header');
    const header = Buffer.alloc(jsonBytes); fs.readSync(fd, header, 0, jsonBytes, 16);
    let item = JSON.parse(header.toString('utf8'));
    for (const part of name.split('/')) { if (!part || part === '..') throw new Error('invalid_asar_path'); item = item.files?.[part]; if (!item) throw new Error('asar_entry_missing:' + name); }
    if (item.unpacked) return fs.readFileSync(path.join(file + '.unpacked', ...name.split('/')));
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > 32 * 1024 * 1024 || !/^\d+$/.test(item.offset)) throw new Error('invalid_asar_entry');
    const data = Buffer.alloc(item.size); let offset = 0;
    while (offset < data.length) { const n = fs.readSync(fd, data, offset, data.length - offset, 8 + headerBytes + Number(item.offset) + offset); if (!n) throw new Error('short_asar_read'); offset += n; }
    return data;
  } finally { fs.closeSync(fd); }
}

export function readFuses(executable) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const fd = fs.openSync(executable, 'r'), chunk = Buffer.alloc(1024 * 1024);
  let tail = Buffer.alloc(0), offset = 0;
  try {
    while (true) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, offset); if (!n) break;
      const data = Buffer.concat([tail, chunk.subarray(0, n)]), p = data.indexOf(sentinel);
      if (p >= 0 && p + sentinel.length + 2 < data.length) {
        const start = p + sentinel.length, version = data[start], count = data[start + 1];
        const values = data.subarray(start + 2, start + 2 + count).toString('ascii');
        if (values.length !== count) throw new Error('fuse_wire_crosses_read_boundary');
        return { version, values, runAsNode: values[0], nodeOptions: values[2], embeddedAsarIntegrity: values[4], onlyLoadAppFromAsar: values[5] };
      }
      tail = data.subarray(-256); offset += n;
    }
    throw new Error('fuse_sentinel_not_found');
  } finally { fs.closeSync(fd); }
}
