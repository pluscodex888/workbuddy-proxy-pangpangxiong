import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventJournal} from '../src/event-journal.mjs';
import {randomBytes} from 'node:crypto';
import {digest} from '../src/contracts.mjs';
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'journal-compression-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};

test('more than 64 MiB of native cumulative tool events survives compressed durable replay with legacy prefix intact',t=>{
 const root=tmp(t),j=new EventJournal(root),file=path.join(root,'events.wal');
 j.commit({turn:{id:'tool',state:'running',seq:0}});
 const prefix=fs.readFileSync(file),content='const pixel = {x: 12, y: 34, color: "blue"};\n'.repeat(1200);
 let logicalBytes=0;
 for(let seq=1;seq<=1500;seq++){
  const tx={turn:{id:'tool',state:seq===1500?'completed':'running',seq},event:{turnId:'tool',seq,type:'tool.update',payload:{content,seq,status:seq===1500?'completed':'in_progress'}}};
  logicalBytes+=Buffer.byteLength(JSON.stringify(tx));j.commit(tx);
 }
 j.close();const raw=fs.readFileSync(file);
 assert.ok(logicalBytes>64*1024*1024);assert.ok(raw.length<2*1024*1024);
 assert.deepEqual(raw.subarray(0,prefix.length),prefix);
 const restored=new EventJournal(root);
 try{
  assert.equal(restored.turn('tool').state,'completed');
  const events=restored.page('tool',0,1500);assert.equal(events.length,1500);
  for(let i=0;i<events.length;i++)assert.deepEqual(events[i].payload,{content,seq:i+1,status:i===1499?'completed':'in_progress'});
 }finally{restored.close();}
});

test('compressed record tampering fails closed without altering the journal',t=>{
 const root=tmp(t),j=new EventJournal(root),file=path.join(root,'events.wal');
 j.commit({turn:{id:'x',state:'completed',text:'hello '.repeat(1000)}});j.close();
 const entry=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(entry.schema,2);
 entry.transaction=entry.transaction.slice(0,-5)+'AAAAA';
 const damaged=JSON.stringify(entry)+'\n';fs.writeFileSync(file,damaged);
 assert.throws(()=>new EventJournal(root),/journal_corrupt/);
 assert.equal(fs.readFileSync(file,'utf8'),damaged);
});

test('storage cap remains enforced and cannot publish an uncommitted event',t=>{
 const root=tmp(t),j=new EventJournal(root,{maxBytes:1200});
 try{
  j.commit({turn:{id:'x',state:'running',seq:0}});
  assert.throws(()=>j.commit({turn:{id:'x',state:'completed',seq:1},event:{turnId:'x',seq:1,payload:'x'.repeat(1500)}}),/journal_capacity_exceeded/);
  assert.equal(j.turn('x').state,'running');assert.equal(j.page('x').length,0);
 }finally{j.close();}
});

test('growing high-entropy tool snapshots replay exactly within a bounded journal, interleaved with reasoning',t=>{
 const root=tmp(t),j=new EventJournal(root,{maxBytes:4*1024*1024});
 const expected=[],source=randomBytes(180000).toString('base64');let seq=0;
 for(let i=0;i<600;i++){
  const tool={turnId:'native',seq:++seq,type:'tool.update',payload:{toolCallId:'write',rawInput:{file_path:'index.html',content:source.slice(0,120000+i*180)},status:i===599?'completed':'in_progress'}};
  j.commit({turn:{id:'native',state:'running',seq},event:tool});expected.push(tool);
  const reasoning={turnId:'native',seq:++seq,type:'reasoning.delta',payload:{text:'piece '+i}};
  j.commit({turn:{id:'native',state:i===599?'completed':'running',seq},event:reasoning});expected.push(reasoning);
 }
 j.close();const bytes=fs.readFileSync(path.join(root,'events.wal'));
 assert.ok(bytes.length<2*1024*1024);assert.ok(bytes.includes(Buffer.from('"schema":3')));
 const restored=new EventJournal(root,{maxBytes:4*1024*1024});
 try{assert.equal(restored.turn('native').state,'completed');assert.deepEqual(restored.page('native',0,2000),expected);}finally{restored.close();}
});

test('delta replay rejects a missing base even when the record hash is recomputed',t=>{
 const root=tmp(t),j=new EventJournal(root),file=path.join(root,'events.wal');
 const text=randomBytes(12000).toString('hex');
 for(let seq=1;seq<=2;seq++)j.commit({event:{turnId:'x',seq,type:'tool.update',payload:{text:text+seq}}});
 j.close();const records=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse),last=records.at(-1);
 assert.equal(last.schema,3);last.baseRevision=999;
 const {hash,...body}=last;last.hash=digest(body);const damaged=records.map(x=>JSON.stringify(x)).join('\n')+'\n';fs.writeFileSync(file,damaged);
 assert.throws(()=>new EventJournal(root),/journal_corrupt/);assert.equal(fs.readFileSync(file,'utf8'),damaged);
});
