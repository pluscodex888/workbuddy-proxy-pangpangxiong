import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { BridgeError, check, digest, terminal } from './contracts.mjs';
import { makeDelta, applyDelta, deltaKey } from './journal-delta.mjs';

/** One fsynced, hash-chained transaction contains state AND its published event.
 * A failed append poisons the writer: no later output can claim durability.
 * Runtime contents are private; reports contain only test counts and hashes. */
export class EventJournal {
  constructor(root, { maxBytes = 64 * 1024 * 1024, io = fs, fileName = 'events.wal' } = {}) {
    check(/^events(?:-v[1-9][0-9]*)?\.wal$/.test(fileName), 'invalid_journal_filename');
    this.io = io; this.root = path.resolve(root); this.maxBytes = maxBytes;
    this.sessions = new Map(); this.turns = new Map(); this.events = new Map();
    this.deltaBases = new Map(); this.deltaBytes = 0;
    this.revision = 0; this.previous = '0'.repeat(64); this.bytes = 0; this.poisoned = false;
    io.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.lockPath = path.join(root, 'writer.lock');
    this.lockToken = randomUUID();
    try { this.lock = io.openSync(this.lockPath, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Serialize stale-lock recovery itself. Re-read only after owning this
      // guard, so a second recoverer cannot rename a newly acquired writer.
      const recoveryPath = path.join(root, 'writer-recovery.lock');
      let recovery;
      try { recovery = io.openSync(recoveryPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new BridgeError('journal_recovery_locked', 503); throw error; }
      try {
      io.writeFileSync(recovery, JSON.stringify({ pid: process.pid, token: this.lockToken }));
      io.fsyncSync(recovery);
      check(io.statSync(this.lockPath).size <= 4096, 'journal_writer_lock_invalid', 503);
      const bytes = io.readFileSync(this.lockPath), prior = JSON.parse(bytes);
      check(Number.isSafeInteger(prior.pid) && prior.pid > 0 && typeof prior.token === 'string', 'journal_writer_lock_invalid', 503);
      let dead = false;
      try { process.kill(prior.pid, 0); } catch (error) { if (error.code === 'ESRCH') dead = true; }
      check(dead, 'journal_writer_locked', 503);
      const retained = path.join(root, `writer.interrupted-${digest(prior)}.json`);
      check(!io.existsSync(retained), 'journal_writer_recovery_conflict', 503);
      // Preserve the original lock as recovery evidence. Never kill another
      // writer, delete a journal, or infer death from timestamps.
      io.renameSync(this.lockPath, retained);
      this.lock = io.openSync(this.lockPath, 'wx', 0o600);
      this.recoveredWriter = { deadPid: prior.pid, retained };
      } finally { io.closeSync(recovery); io.unlinkSync(recoveryPath); }
    }
    try {
      io.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, token: this.lockToken }));
      io.fsyncSync(this.lock);
      this.file = path.join(root, fileName);
      if (io.existsSync(this.file)) {
        check(io.statSync(this.file).size <= maxBytes, 'journal_capacity_exceeded', 507);
        const raw = io.readFileSync(this.file, 'utf8');
        check(!raw || raw.endsWith('\n'), 'journal_partial_tail_requires_reconciliation', 503);
        this.bytes = Buffer.byteLength(raw);
        for (const line of raw.split('\n').filter(Boolean)) {
          let entry; try { entry = JSON.parse(line); } catch { throw new BridgeError('journal_corrupt', 503); }
          const { hash, ...body } = entry;
          check([1, 2, 3].includes(body.schema) && body.revision === this.revision + 1 && body.previous === this.previous && digest(body) === hash, 'journal_corrupt', 503);
          let transaction = body.transaction;
          if (body.schema === 2) {
            check(body.encoding === 'gzip-base64' && typeof transaction === 'string', 'journal_corrupt', 503);
            try { transaction = JSON.parse(gunzipSync(Buffer.from(transaction, 'base64'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8')); }
            catch { throw new BridgeError('journal_corrupt', 503); }
          }
          if(body.schema===3){
            const base=this.deltaBases.get(body.baseKey);
            check(body.encoding==='json-delta'&&base&&base.revision===body.baseRevision,'journal_corrupt',503);
            try{transaction=applyDelta(base.transaction,transaction);}catch{throw new BridgeError('journal_corrupt',503);}
            check(deltaKey(transaction)===body.baseKey&&Buffer.byteLength(JSON.stringify(transaction))<=16*1024*1024,'journal_corrupt',503);
          }
          this.apply(transaction); this.revision = body.revision; this.previous = hash;
          this.rememberDelta(transaction,body.revision);
        }
      }
      this.fd = io.openSync(this.file, 'a', 0o600);
      for (const s of this.sessions.values()) if (s.state === 'creating') s.state = 'in_doubt';
      for (const t of this.turns.values()) if (!terminal.has(t.state)) {
        t.state = 'in_doubt'; t.recoveryReason = 'process_restart_requires_native_reconciliation';
      }
    } catch (e) { this.close(); throw e; }
  }
  rememberDelta(transaction,revision){
    const key=deltaKey(transaction);if(key===null)return;
    const old=this.deltaBases.get(key);if(old){this.deltaBytes-=old.bytes;this.deltaBases.delete(key);}
    const bytes=Buffer.byteLength(JSON.stringify(transaction));
    if(bytes>16*1024*1024)return;
    this.deltaBases.set(key,{transaction:structuredClone(transaction),revision,bytes});this.deltaBytes+=bytes;
    while(this.deltaBases.size>32||this.deltaBytes>16*1024*1024){const [key,base]=this.deltaBases.entries().next().value;this.deltaBytes-=base.bytes;this.deltaBases.delete(key);}
  }
  apply(tx) {
    if (tx.session) this.sessions.set(tx.session.id, tx.session);
    if (tx.turn) this.turns.set(tx.turn.id, tx.turn);
    if (tx.event) {
      const list = this.events.get(tx.event.turnId) ?? [];
      check(tx.event.seq === list.length + 1, 'journal_sequence_corrupt', 503);
      list.push(tx.event); this.events.set(tx.event.turnId, list);
    }
  }
  commit(transaction) {
    check(this.fd !== undefined && !this.poisoned, 'delivery_storage_unavailable', 507);
    // Hash exactly the JSON representation that will be persisted. Native
    // events contain optional undefined properties, which JSON omits; dates
    // and non-finite numbers likewise need normalization before hashing.
    let normalized;
    try { normalized = JSON.parse(JSON.stringify(transaction)); }
    catch { throw new BridgeError('journal_transaction_not_json', 507); }
    const body = { schema: 1, revision: this.revision + 1, previous: this.previous, transaction: normalized };
    // Native tool updates repeatedly carry their complete growing arguments.
    // Compress large transactions independently: no events are dropped or
    // coalesced, and legacy hash-chain entries remain untouched and readable.
    const json = JSON.stringify(normalized), size = Buffer.byteLength(json);
    check(size <= 16 * 1024 * 1024, 'journal_transaction_too_large', 507);
    if (size >= 4096) {
      const compressed = gzipSync(json, { level: 1 }).toString('base64');
      if (compressed.length + 64 < size) {
        body.schema = 2; body.encoding = 'gzip-base64'; body.transaction = compressed;
      }
    }
    const baseKey=deltaKey(normalized),base=this.deltaBases.get(baseKey);
    if(base&&size>=512){
      const delta={schema:3,revision:body.revision,previous:body.previous,encoding:'json-delta',baseKey,baseRevision:base.revision,transaction:makeDelta(base.transaction,normalized)};
      if(Buffer.byteLength(JSON.stringify(delta))+64<Buffer.byteLength(JSON.stringify(body))){
        for(const key of Object.keys(body))delete body[key];Object.assign(body,delta);
      }
    }
    const hash = digest(body), bytes = Buffer.from(JSON.stringify({ ...body, hash }) + '\n');
    check(this.bytes + bytes.length <= this.maxBytes, 'journal_capacity_exceeded', 507);
    try {
      let written = 0;
      while (written < bytes.length) {
        const count = this.io.writeSync(this.fd, bytes, written, bytes.length - written);
        if (!count) throw new Error('short_write');
        written += count;
      }
      this.io.fsyncSync(this.fd);
    } catch { this.poisoned = true; throw new BridgeError('delivery_storage_unavailable', 507); }
    this.apply(normalized); this.revision = body.revision; this.previous = hash; this.bytes += bytes.length;
    this.rememberDelta(normalized,this.revision);
  }
  session(id) { return structuredClone(this.sessions.get(id)); }
  turn(id) { return structuredClone(this.turns.get(id)); }
  page(turnId, after = 0, limit = 128) { return structuredClone((this.events.get(turnId) ?? []).slice(after, after + limit)); }
  close() {
    if (this.fd !== undefined) { this.io.closeSync(this.fd); this.fd = undefined; }
    if (this.lock !== undefined) {
      this.io.closeSync(this.lock); this.lock = undefined;
      // Release only this process's operational lock, never delete runtime data.
      const value = JSON.parse(this.io.readFileSync(this.lockPath, 'utf8'));
      if (value.token === this.lockToken) this.io.unlinkSync(this.lockPath);
    }
  }
}
