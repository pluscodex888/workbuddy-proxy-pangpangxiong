export const HELP_ITEM_ID = 'workbaby-help-task-timeline';
const nativeMenus = new WeakMap();

/** Official native menus can be rebuilt after login/language/window changes. */
export function attachNativeHelpMenu(Menu, open, {id=HELP_ITEM_ID,label='自动任务流水'}={}) {
  if (!Menu?.setApplicationMenu) return {dispose(){}};
  let state = nativeMenus.get(Menu);
  if (!state) {
    const original = Menu.setApplicationMenu;
    const entries = new Set();
    const wrapped = function(menu, ...args) {
      const help = menu?.items?.find(x => x.role === 'help' || /help|帮助/i.test(x.label ?? ''))?.submenu;
      if (help) {
        for (const entry of entries) {
          if (!help.items.some(item => item.id === entry.id)) {
            help.append(Menu.buildFromTemplate([entry]).items[0]);
          }
        }
      }
      return Reflect.apply(original, this, [menu, ...args]);
    };
    state = {original, entries, wrapped};
    nativeMenus.set(Menu, state);
    Menu.setApplicationMenu = wrapped;
  }
  const entry = {id, label, click:open};
  state.entries.add(entry);
  const current = Menu.getApplicationMenu();
  if (current) Menu.setApplicationMenu(current);
  return {dispose() {
    state.entries.delete(entry);
    if (state.entries.size || nativeMenus.get(Menu) !== state) return;
    if (Menu.setApplicationMenu === state.wrapped) Menu.setApplicationMenu = state.original;
    nativeMenus.delete(Menu);
  }};
}
