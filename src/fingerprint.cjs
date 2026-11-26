const crypto = require('node:crypto');
const sha256 = value => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');

// Hash complete plain data without invoking getters, toJSON or consuming streams.
// Oversized/non-data inputs are explicitly unavailable. Never persist raw keys.
function fingerprint(value) {
  let nodes = 0, bytes = 0;
  const seen = new Set(), hash = crypto.createHash('sha256');
  const put = text => {
    bytes += Buffer.byteLength(text);
    if (bytes > 8 * 1024 * 1024) throw Error('fingerprint_limit');
    hash.update(text);
  };
  function visit(v, depth = 0) {
    if (++nodes > 100000 || depth > 64) throw Error('fingerprint_limit');
    if (v === null) { put('null;'); return; }
    const type = typeof v;
    put(type + ':');
    if (type === 'undefined') return;
    if (type === 'string' || type === 'boolean' || type === 'bigint') { put(JSON.stringify(String(v))); return; }
    if (type === 'number') { put(Object.is(v, -0) ? '-0' : String(v)); return; }
    if (type !== 'object') throw Error('unsupported_value');
    if (seen.has(v)) throw Error('cyclic_value');
    if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw Error('opaque_object');
    seen.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    put(Array.isArray(v) ? 'array[' : 'object{');
    for (const key of Object.keys(descriptors).sort()) {
      const d = descriptors[key];
      if (!d.enumerable && key !== 'length') continue;
      if (!Object.hasOwn(d, 'value')) throw Error('accessor_value');
      put(JSON.stringify(key)); visit(d.value, depth + 1);
    }
    put('};'); seen.delete(v);
  }
  try {
    visit(value);
    return { algorithm: 'sha256-canonical-data-v2', sha256: hash.digest('hex'), complete: true,
      shape: { type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, nodes } };
  } catch (error) {
    return { algorithm: 'sha256-canonical-data-v2', complete: false,
      reason: ['fingerprint_limit','unsupported_value','cyclic_value','opaque_object','accessor_value'].includes(error?.message) ? error.message : 'unavailable' };
  }
}
module.exports = { sha256, fingerprint };
