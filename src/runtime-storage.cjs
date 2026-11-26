const fs=require('node:fs');
const MODEL_STORAGE_RESERVE=64*1024*1024;
const DIAGNOSTIC_STORAGE_RESERVE=512*1024*1024;
function probeStorage(root,probe=fs.statfsSync){
  if(typeof probe!=='function')return null;
  try{const s=probe(root),n=Number(s.bavail)*Number(s.bsize);return Number.isSafeInteger(n)&&n>=0?n:null;}
  catch(e){if(['ENOSYS','ENOTSUP','EINVAL','ERR_METHOD_NOT_IMPLEMENTED'].includes(e.code))return null;throw e;}
}
function assertRuntimeStorage(root,{probe=fs.statfsSync,minFreeBytes=MODEL_STORAGE_RESERVE}={}){
  const free=probeStorage(root,probe);
  if(free!==null&&free<minFreeBytes){const e=Object.assign(new Error('node_storage_full'),{code:'ENOSPC',syscall:'preflight',storageFreeBytes:free,storageReserveBytes:minFreeBytes});throw e;}
  return free;
}
function storageErrorDetails(error){
  if(!['ENOSPC','EDQUOT'].includes(error?.code))return null;
  const out={storage_code:error.code};
  if(['preflight','open','write','fsync','rename','mkdir'].includes(error.syscall))out.storage_operation=error.syscall;
  if(Number.isSafeInteger(error.storageFreeBytes)&&error.storageFreeBytes>=0)out.storage_free_bytes=error.storageFreeBytes;
  if(Number.isSafeInteger(error.storageReserveBytes)&&error.storageReserveBytes>=0)out.storage_reserve_bytes=error.storageReserveBytes;
  if(['not_started','unknown'].includes(error.workbabyDispatchState))out.dispatch_state=error.workbabyDispatchState;
  return out;
}
module.exports={MODEL_STORAGE_RESERVE,DIAGNOSTIC_STORAGE_RESERVE,probeStorage,assertRuntimeStorage,storageErrorDetails};
