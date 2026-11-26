// Lossless deltas for cumulative native tool snapshots. Transport events remain
// complete; only their on-disk representation refers to a preceding snapshot.
const object=v=>v!==null&&typeof v==='object';
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
export function makeDelta(before,after,path=[],out=[]){
  if(before===after)return out;
  if(typeof before==='string'&&typeof after==='string'&&after.length>=256){
    let prefix=0,suffix=0;
    while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
    while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
    if(prefix+suffix>128){out.push({path,op:'string',prefix,suffix,value:after.slice(prefix,after.length-suffix)});return out;}
  }
  if(object(before)&&object(after)&&Array.isArray(before)===Array.isArray(after)&&(!Array.isArray(before)||before.length===after.length)){
    for(const key of Object.keys(before))if(!own(after,key))out.push({path:[...path,key],op:'delete'});
    for(const key of Object.keys(after)){
      if(own(before,key))makeDelta(before[key],after[key],[...path,key],out);
      else out.push({path:[...path,key],op:'set',value:after[key]});
    }
  }else out.push({path,op:'set',value:after});
  return out;
}
export function applyDelta(before,patches){
  let result=structuredClone(before);
  if(!Array.isArray(patches))throw Error('invalid_delta');
  for(const patch of patches){
    const {path,op}=patch;
    if(!Array.isArray(path)||!path.every(k=>typeof k==='string'))throw Error('invalid_delta');
    let parent,old=result,key;
    for(let i=0;i<path.length;i++){
      key=path[i];parent=old;
      if(!object(parent)||(i<path.length-1&&!own(parent,key)))throw Error('invalid_delta');
      old=own(parent,key)?parent[key]:undefined;
    }
    let next;
    if(op==='set')next=structuredClone(patch.value);
    else if(op==='string'){
      const {prefix,suffix,value}=patch;
      if(typeof old!=='string'||typeof value!=='string'||!Number.isSafeInteger(prefix)||!Number.isSafeInteger(suffix)||prefix<0||suffix<0||prefix+suffix>old.length)throw Error('invalid_delta');
      next=old.slice(0,prefix)+value+(suffix?old.slice(old.length-suffix):'');
    }else if(op==='delete'){
      if(!parent||!own(parent,key)||Array.isArray(parent))throw Error('invalid_delta');
      delete parent[key];continue;
    }else throw Error('invalid_delta');
    if(!path.length)result=next;
    else Object.defineProperty(parent,key,{value:next,enumerable:true,writable:true,configurable:true});
  }
  return result;
}
export function deltaKey(tx){
  return typeof tx?.event?.type==='string'&&typeof tx.event.turnId==='string'?JSON.stringify([tx.event.turnId,tx.event.type]):null;
}
