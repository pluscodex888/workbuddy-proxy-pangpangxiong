// Public diagnostic scalars only. Never expose provider messages, bodies,
// cookies, authorization, request objects or arbitrary header mappings.
const scalar=value=>typeof value==='number'&&Number.isSafeInteger(value)?value:
 typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value)?value:undefined;
function header(headers,name){
 if(typeof headers?.get==='function')return headers.get(name);
 if(headers&&typeof headers==='object'){
  const key=Object.keys(headers).find(key=>key.toLowerCase()===name);
  if(key===undefined)return undefined;
  const value=headers[key];return Array.isArray(value)?value[0]:value;
 }
}
function upstreamDetails(value){
 const nested=value?.error??value?.response?.error??{};
 const status=value?.status??value?.response?.status;
 const headers=value?.headers??value?.response?.headers;
 const details={};
 if(Number.isInteger(status)&&status>=400&&status<=599)details.upstream_status=status;
 const code=scalar(nested.code??value?.code??value?.upstream_code);
 if(code!==undefined)details.upstream_code=code;
 const request=scalar(value?.request_id??value?._request_id??value?.response?.request_id??nested.request_id??header(headers,'x-request-id')??header(headers,'request-id'));
 if(request!==undefined)details.upstream_request_id=request;
 const retry=nested.retry_after??value?.retry_after??header(headers,'retry-after');
 if(typeof retry==='number'&&Number.isFinite(retry)&&retry>=0&&retry<=604800)details.retry_after=retry;
 else if(typeof retry==='string'&&(/^\d{1,6}(?:\.\d{1,3})?$/.test(retry)
  ||/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)&&Number.isFinite(Date.parse(retry))))details.retry_after=retry;
 return details;
}
function safeUpstreamDetails(value){
 if(!value||typeof value!=='object')return {};
 return upstreamDetails({status:value.upstream_status,error:{code:value.upstream_code},request_id:value.upstream_request_id,retry_after:value.retry_after});
}
module.exports={upstreamDetails,safeUpstreamDetails};
