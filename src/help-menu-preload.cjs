// Runs in the isolated preload world; only the official local main document
// gets this single-purpose menu action. No general IPC is exposed to the page.
const { ipcRenderer } = require('electron');
if (location.protocol === 'file:' && /\/app\.asar\/renderer\/index\.html$/i.test(location.pathname)) {
  function sync(entries) {
    const help = [...document.querySelectorAll('.codebuddy-menubar .menubar-menu-button')]
      .find(n => /^(help|帮助)/i.test(n.textContent.trim()) && n.getAttribute('aria-expanded') === 'true');
    if (!help) return;
    const lists = [...document.querySelectorAll('.menu-list')].filter(n => n.getBoundingClientRect().width > 0);
    if (lists.length !== 1) return;
    for(const {id,label:entryLabel,channel} of entries){
    if(document.getElementById(id))continue;
    const list = lists[0], item = document.createElement('div');
    item.id = id; item.className = 'menu-item'; item.setAttribute('role','menuitem'); item.tabIndex = 0;
    const label = document.createElement('span'); label.className = 'menu-item-label'; label.textContent = entryLabel; item.append(label);
    item.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    const open = e => {
      e.preventDefault(); e.stopPropagation();
      help.click();
      void ipcRenderer.invoke(channel).catch(() => {});
    };
    item.addEventListener('click', open);
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(e); });
    item.addEventListener('mouseenter', () => { item.classList.add('focused'); item.focus(); });
    item.addEventListener('mouseleave', () => item.classList.remove('focused'));
    list.append(item);
    }
  }
  window.addEventListener('DOMContentLoaded', async () => {
    const entries = await ipcRenderer.invoke('workbaby-help-entries').catch(() => []);
    if (!entries.length) return;
    const observer = new MutationObserver(() => sync(entries));
    observer.observe(document.body, {childList:true,subtree:true,attributes:true,attributeFilter:['aria-expanded']});
    window.addEventListener('unload', () => observer.disconnect(), {once:true});
    sync(entries);
  }, {once:true});
}
