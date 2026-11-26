import {identityKey,BridgeError} from './contracts.mjs';
import fp from './fingerprint.cjs';

// These are declared official daemon actions. The official AuthService owns
// the HTTP client, endpoint, headers, Turing token and request body.
// No upstream URL, request header or HTTP implementation belongs here.
const READ_ACTIONS = Object.freeze({
  usage:'auth:getAccountUsage',
  checkin:'auth:getCheckinStatus',
  activity:'auth:getActivityBanner',
});

export async function readOfficialActivity(adapter,creditPackages) {
  const identity=adapter.currentIdentity();
  const result={schema:'workbaby.official-activity-readback/v1',at:new Date().toISOString(),
    ownerFingerprint:fp.fingerprint({ownerId:identity.ownerId,realm:identity.realm}).sha256,
    realm:identity.realm,networkOwner:'official-auth-service',modelExecuted:false,actions:{}};
  for(const [name,operation] of Object.entries(READ_ACTIONS)){
    if(identityKey(adapter.currentIdentity())!==identityKey(identity))throw new BridgeError('identity_changed',409);
    const started=Date.now(),args=[];
    try{
      const value=await adapter.daemon.server.invokeLocal(operation,...args);
      if(identityKey(adapter.currentIdentity())!==identityKey(identity))throw new BridgeError('identity_changed',409);
      result.actions[name]={operation,inputFingerprint:fp.fingerprint(args).sha256,
        outputFingerprint:fp.fingerprint(value).sha256,elapsedMs:Date.now()-started,
        status:value==null?'unavailable':'returned',value};
    }catch(error){
      if(error?.message==='identity_changed')throw error;
      result.actions[name]={operation,status:'failed',elapsedMs:Date.now()-started,errorName:error?.name??'Error'};
    }
  }
  if(typeof creditPackages==='function')result.creditPackages=creditPackages();
  if(identityKey(adapter.currentIdentity())!==identityKey(identity))throw new BridgeError('identity_changed',409);
  return result;
}
