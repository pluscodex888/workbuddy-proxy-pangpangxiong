import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachNativeHelpMenu } from './help-menu.mjs';

const GROUP_NUMBER = '794944238';
const GROUP_INVITATION = 'https://qm.qq.com/q/qE3D6p3cti';
const SPONSOR_SITE = 'https://n.novecd.com/';
const SPONSOR_GROUP = '555657982';

export function officialMainDocumentGuard(officialRoot) {
  const expected = path.resolve(officialRoot, 'resources/app.asar/renderer/index.html').toLowerCase();
  return event => {
    let filename;
    try { filename = path.resolve(fileURLToPath(event.senderFrame.url)).toLowerCase(); } catch {}
    if (event.senderFrame !== event.sender.mainFrame || filename !== expected) throw Error('official_main_document_required');
  };
}

export function preparePublicDesktopCommunity(electron, officialRoot) {
  const install = () => {
    const session = electron.session.defaultSession;
    const preload = fileURLToPath(new URL('./help-menu-preload.cjs', import.meta.url));
    const community = attachDesktopCommunity(electron, officialMainDocumentGuard(officialRoot));
    session.setPreloads([...new Set([...session.getPreloads(), preload])]);
    electron.app.once('will-quit', () => {
      community.dispose();
      session.setPreloads(session.getPreloads().filter(filename => filename !== preload));
    });
  };
  if (electron.app.isReady()) install();
  else electron.app.once('ready', install);
}

export function attachDesktopCommunity({ Menu, clipboard, dialog, ipcMain, shell }, requireOfficialMainDocument, precedingEntries = []) {
  const openCommunity = () => shell.openExternal(GROUP_INVITATION).catch(() => {
    dialog.showErrorBox('胖胖熊·交流群', `无法打开邀请页面。请在 QQ 搜索群号 ${GROUP_NUMBER}。`);
  });

  const openSponsor = async () => {
    const {response} = await dialog.showMessageBox({
      type:'info',
      title:'赞助商 · novecloud',
      message:'novecloud 自研加密隧道',
      detail:`新人首月送 200G 流量免费体验。\nQQ群 ${SPONSOR_GROUP}\n官网 ${SPONSOR_SITE}`,
      buttons:['打开官网', '复制 QQ 群号', '关闭'],
      defaultId:0,
      cancelId:2,
      noLink:true
    });
    if (response === 0) await shell.openExternal(SPONSOR_SITE);
    if (response === 1) clipboard.writeText(SPONSOR_GROUP);
  };

  const entries = [
    {id:'workbaby-help-community', label:'胖胖熊·交流群', channel:'workbaby-open-community', open:openCommunity},
    {id:'workbaby-help-sponsor', label:'赞助商 · novecloud', channel:'workbaby-open-sponsor', open:openSponsor}
  ];
  const advertised = [...precedingEntries, ...entries.map(({id, label, channel}) => ({id, label, channel}))];
  ipcMain.handle('workbaby-help-entries', event => {
    requireOfficialMainDocument(event);
    return advertised;
  });
  const menus = entries.map(({id, label, channel, open}) => {
    const show = () => open().catch(() => dialog.showErrorBox(label, '打开链接失败。'));
    ipcMain.handle(channel, event => {
      requireOfficialMainDocument(event);
      return show();
    });
    return attachNativeHelpMenu(Menu, show, {id, label});
  });
  return {dispose() {
    for (const menu of menus) menu.dispose();
    for (const {channel} of entries) ipcMain.removeHandler(channel);
    ipcMain.removeHandler('workbaby-help-entries');
  }};
}
