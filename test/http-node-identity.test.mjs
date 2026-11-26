import test from 'node:test';
import assert from 'node:assert/strict';
import {httpNodeIdentity, httpNodeMetadata, assertHttpNodeBinding} from '../src/http-node-identity.mjs';
import {startHttpApi} from '../src/http-api.mjs';
import http from 'node:http';

test('node binding changes with account/instance, survives credential generation, and exposes no secrets',()=>{
  const who={instanceId:'node-A',ownerId:'account-A',realm:'intl',generation:'token-generation-A'};
  const service={adapter:{currentIdentity:()=>who}};
  const first=httpNodeIdentity(service);
  assert.equal(first.account_uid,'account-A');
  assert.equal(JSON.stringify(first).includes('generation'),false);
  assertHttpNodeBinding(service,{'x-workbaby-expected-identity':first.identity_fingerprint});
  who.generation='token-generation-B';
  assert.equal(httpNodeIdentity(service).identity_fingerprint,first.identity_fingerprint);
  who.ownerId='account-B';
  assert.throws(()=>assertHttpNodeBinding(service,{'x-workbaby-expected-identity':first.identity_fingerprint}),e=>e.code==='node_account_changed'&&e.status===409);
  assertHttpNodeBinding(service,{});
  assert.throws(()=>assertHttpNodeBinding(service,{'x-workbaby-expected-identity':'bad'}),e=>e.code==='invalid_node_binding');
});

test('HTTP node guard checks the account after upload and before any provider allocation',async t=>{
 const who={instanceId:'node-A',ownerId:'account-A',realm:'intl',generation:'A'};
 let sends=0;
 const service={adapter:{currentIdentity:()=>({...who})},limits:{inputBytes:10000},rawHttp:{complete:async()=>{sends++;},modelCatalog:[]}};
 const expected=httpNodeIdentity(service).identity_fingerprint;
 const api=await startHttpApi(service,{token:'test-node-token-01234567890123456789'});t.after(()=>api.close());
 const result=new Promise((resolve,reject)=>{
   const req=http.request(new URL('/v1/chat/completions',api.url),{method:'POST',headers:{authorization:'Bearer test-node-token-01234567890123456789','content-type':'application/json','x-workbaby-expected-identity':expected}},res=>{
    let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
   });req.on('error',reject);req.write('{"model":"gpt-6-luna",');
   setTimeout(()=>{who.ownerId='account-B';req.end('"messages":[{"role":"user","content":"test"}]}');},30);
 });
 const response=await result;
 assert.equal(response.status,409);assert.equal(response.body.error.code,'node_account_changed');assert.equal(sends,0);
});

test('subscription proof comes only from identity-bound official metadata, never credits',async()=>{
 const who={instanceId:'node-A',ownerId:'account-A',realm:'intl',generation:'A'};
 let result={isPro:true};
 const service={adapter:{currentIdentity:()=>who,daemon:{server:{invokeLocal:async action=>{assert.equal(action,'auth:getAccountUsage');return result;}}}}};
 assert.equal((await httpNodeMetadata(service)).membership.paid,true);
 result={credits:100};assert.equal((await httpNodeMetadata(service)).membership.paid,null);
 service.adapter.daemon.server.invokeLocal=async()=>{who.ownerId='other';return {isPro:true};};
 await assert.rejects(httpNodeMetadata(service),e=>e.code==='identity_changed');
});
