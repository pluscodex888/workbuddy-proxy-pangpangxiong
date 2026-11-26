// These are aliases for the official WorkBuddy catalog. They do not create a
// second provider or bypass the official account/session authentication.
export const DEFAULT_RAW_MODEL_CATALOG = Object.freeze([
  Object.freeze({ id: 'deepseek-v4.1-flash-sg', upstreamModel: 'deepseek-v4.1-flash-sg', aliases: ['deepseek-flash','deepseek-v4.1-flash','ds-test'] }),
  Object.freeze({ id: 'deepseek-v4-pro', upstreamModel: 'deepseek-v4-pro', aliases: ['deepseek-pro'] }),
  Object.freeze({ id: 'GLM-5.3', upstreamModel: 'glm-5.3', aliases: ['glm-5.3','glm5.3'] }),
  Object.freeze({ id: 'GLM-5.3-Flash', upstreamModel: 'glm-5.3-flash', aliases: ['glm-5.3-flash', 'glm-test'] }),
]);

function validEntry(entry) {
  return entry && typeof entry.id === 'string' && entry.id.length > 0 &&
    typeof entry.upstreamModel === 'string' && entry.upstreamModel.length > 0;
}

export function createRawModelCatalog(entries = DEFAULT_RAW_MODEL_CATALOG) {
  const source = Array.isArray(entries) ? entries : DEFAULT_RAW_MODEL_CATALOG;
  const result = [];
  const seen = new Set();
  for (const raw of source) {
    if (!validEntry(raw) || seen.has(raw.id)) continue;
    const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter(alias => typeof alias === 'string' && alias.length > 0 && alias !== raw.id) : [];
    result.push(Object.freeze({
      id: raw.id,
      upstreamModel: raw.upstreamModel,
      aliases: Object.freeze([...new Set(aliases)])
    }));
    seen.add(raw.id);
  }
  return Object.freeze(result);
}

export function resolveRawModel(model, catalog = DEFAULT_RAW_MODEL_CATALOG) {
  if(isNonPublicRawModel(model,catalog))return null;
  const entries = createRawModelCatalog(catalog);
  const value=typeof model==='string'?model.trim().toLowerCase():'';
  const entry=entries.find(item=>[item.id,item.upstreamModel,...item.aliases].some(id=>id.toLowerCase()===value));
  // User's explicit public allowlist; unknown official IDs are private too.
  if(entry&&DEFAULT_RAW_MODEL_CATALOG.some(item=>item.upstreamModel===entry.upstreamModel))return entry;
  return null;
}

// Public HTTP policy, not an official client/model configuration change.
// Resolve aliases against both the configured and built-in catalog so removing
// a private entry cannot accidentally enable its alias through the fallback.
export function isNonPublicRawModel(model,catalog=DEFAULT_RAW_MODEL_CATALOG){
  if(typeof model!=='string')return false;
  if(model.trim().toLowerCase()==='gpt-test')return true;
  const family=value=>{
    const name=value.normalize('NFKC').trim().toLowerCase().split(/[/:]/).at(-1).replace(/[\s_\u2010-\u2015]+/g,'-');
    return /^gpt-?(?:6(?:[.-]\d+)?|5[.-]?6)(?:$|[a-z.-])/.test(name);
  };
  if(family(model))return true;
  const entries=[...createRawModelCatalog(catalog),...DEFAULT_RAW_MODEL_CATALOG];
  return entries.some(entry=>(entry.id.toLowerCase()===model.trim().toLowerCase()||entry.upstreamModel.toLowerCase()===model.trim().toLowerCase()||entry.aliases.some(alias=>alias.toLowerCase()===model.trim().toLowerCase()))&&(family(entry.id)||family(entry.upstreamModel)));
}

export function rawModelListing(catalog = DEFAULT_RAW_MODEL_CATALOG) {
  return createRawModelCatalog(catalog).filter(entry=>resolveRawModel(entry.id,catalog)).map(entry => ({
    id: entry.id,
    object: 'model',
    created: 0,
    owned_by: 'workbuddy',
    upstream_model: entry.upstreamModel
  }));
}

