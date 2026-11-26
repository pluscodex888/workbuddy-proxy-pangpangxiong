// ProductManager fires onDidChange after every volatile provider refresh, even
// when the account's network boundary did not change. Only boundary changes
// invalidate admitted work; owner/login generations remain separate fences.
function createProductGeneration(productManager) {
  if (typeof productManager?.getEndpoint !== 'function' || typeof productManager?.getCurrentConfiguration !== 'function' || typeof productManager?.onDidChange !== 'function') throw new Error('official_product_identity_unavailable');
  const read = () => {
    const endpoint = productManager.getEndpoint();
    const config = productManager.getCurrentConfiguration();
    if (typeof endpoint !== 'string' || !endpoint || !config || typeof config !== 'object') throw new Error('official_product_identity_unavailable');
    return JSON.stringify([endpoint.replace(/\/+$/, ''), config.networkEnvironment ?? null]);
  };
  let boundary = read(), generation = 0, fault;
  const observe = () => {
    const next = read();
    if (next !== boundary) { boundary = next; generation++; }
  };
  const subscription = productManager.onDidChange(() => {
    try { observe(); } catch (error) { fault = error; }
  });
  return {
    get() { if (fault) throw fault; observe(); return generation; },
    dispose() { if (typeof subscription === 'function') subscription(); else subscription?.dispose?.(); },
  };
}
module.exports = { createProductGeneration };
