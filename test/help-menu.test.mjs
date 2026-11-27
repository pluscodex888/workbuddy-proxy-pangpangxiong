import test from 'node:test';
import assert from 'node:assert/strict';
import {attachNativeHelpMenu,HELP_ITEM_ID} from '../src/help-menu.mjs';
import {attachDesktopCommunity,preparePublicDesktopCommunity} from '../src/desktop-community.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
test('Help entry survives native rebuild without duplication and opens viewer',()=>{
  let current=null,opened=0;
  const Menu={getApplicationMenu:()=>current,setApplicationMenu(menu){current=menu;return 7;},buildFromTemplate:items=>({items})};
  const original=Menu.setApplicationMenu;
  const host=attachNativeHelpMenu(Menu,()=>opened++);
  const build=()=>({items:[{label:'File',submenu:{items:[]}},{label:'Help',submenu:{items:[],append(x){this.items.push(x);}}}]});
  for(let i=0;i<2;i++){
    const menu=build();assert.equal(Menu.setApplicationMenu(menu),7);Menu.setApplicationMenu(menu);
    assert.equal(menu.items.length,2);assert.equal(menu.items[0].submenu.items.length,0);
    const entries=menu.items[1].submenu.items;assert.equal(entries.length,1);assert.equal(entries[0].id,HELP_ITEM_ID);
    assert.equal(entries[0].label,'自动任务流水');entries[0].click();
  }
  assert.equal(opened,2);Menu.setApplicationMenu(null);assert.equal(current,null);
  host.dispose();assert.equal(Menu.setApplicationMenu,original);
});
test('isolated preload injects only Help, survives menu reconstruction, and supports click/Enter',async()=>{
  let observer,ready,invocations=[],expanded=true,buttonText='Help(H)',list;
  const catalog=[
    {id:'workbaby-help-task-timeline',label:'自动任务流水',channel:'workbaby-open-task-timeline'},
    {id:'workbaby-help-accounts',label:'账号切换',channel:'workbaby-open-accounts'},
    {id:'workbaby-help-community',label:'胖胖熊·交流群',channel:'workbaby-open-community'},
    {id:'workbaby-help-sponsor',label:'赞助商 · novecloud',channel:'workbaby-open-sponsor'}
  ];
  class Element {
    constructor(){this.children=[];this.listeners={};this.classList={add(){},remove(){}};}
    setAttribute(k,v){this[k]=v;} append(x){this.children.push(x);} addEventListener(k,v){this.listeners[k]=v;}
    getBoundingClientRect(){return {width:100};} focus(){}
  }
  const help={get textContent(){return buttonText;},getAttribute(){return String(expanded);},click(){expanded=false;list=new Element();}};
  list=new Element();
  const document={body:{},querySelectorAll(s){return s.includes('menubar-menu-button')?[help]:s==='.menu-list'?[list]:[];},getElementById(id){return list.children.find(n=>n.id===id);},createElement(){return new Element();}};
  vm.runInNewContext(fs.readFileSync(new URL('../src/help-menu-preload.cjs',import.meta.url),'utf8'),{
    location:{protocol:'file:',pathname:'/D:/official/resources/app.asar/renderer/index.html'},document,
    window:{addEventListener(k,f){if(k==='DOMContentLoaded')ready=f;}},
    MutationObserver:class{constructor(f){observer=f;}observe(){}disconnect(){}},
    require(){return {ipcRenderer:{async invoke(channel){if(channel==='workbaby-help-entries')return catalog;invocations.push(channel);}}};}
  });
  await ready();assert.deepEqual(list.children.map(n=>n.children[0].textContent),['自动任务流水','账号切换','胖胖熊·交流群','赞助商 · novecloud']);observer();assert.equal(list.children.length,4);
  const event={preventDefault(){},stopPropagation(){}};
  list.children[0].listeners.click(event);assert.deepEqual(invocations,['workbaby-open-task-timeline']);assert.equal(expanded,false);
  expanded=true;buttonText='帮助(H)';observer();assert.equal(list.children.length,4);
  list.children[1].listeners.keydown({...event,key:'Enter'});assert.deepEqual(invocations,['workbaby-open-task-timeline','workbaby-open-accounts']);
  expanded=true;observer();list.children[2].listeners.click(event);
  expanded=true;observer();list.children[3].listeners.keydown({...event,key:' '});
  assert.deepEqual(invocations.slice(2),['workbaby-open-community','workbaby-open-sponsor']);
  expanded=true;buttonText='File(F)';observer();assert.equal(list.children.length,0);
});

test('public startup loads the retained preload and advertises only public Help items', ()=>{
  const events=new Map(), handlers=new Map(), oldPreload='old.cjs';
  let preloads=[oldPreload];
  const electron={
    app:{isReady:()=>false,once:(event,listener)=>events.set(event,listener)},
    session:{defaultSession:{getPreloads:()=>preloads,setPreloads:next=>{preloads=next;}}},
    ipcMain:{handle:(channel,callback)=>handlers.set(channel,callback),removeHandler:channel=>handlers.delete(channel)}
  };
  const root=path.resolve('mock-official');
  preparePublicDesktopCommunity(electron,root);
  assert.deepEqual(preloads,[oldPreload]);
  events.get('ready')();
  assert.equal(preloads.length,2);
  assert.match(preloads[1],/help-menu-preload\.cjs$/);
  const frame={url:pathToFileURL(path.join(root,'resources/app.asar/renderer/index.html')).href};
  const trusted={senderFrame:frame,sender:{mainFrame:frame}};
  const list=handlers.get('workbaby-help-entries');
  assert.deepEqual(list(trusted).map(entry=>entry.label),['胖胖熊·交流群','赞助商 · novecloud']);
  assert.throws(()=>list({...trusted,sender:{mainFrame:{...frame}}}),/official_main_document_required/);
  events.get('will-quit')();
  assert.deepEqual(preloads,[oldPreload]);
  assert.equal(handlers.size,0);
});

test('community and sponsor follow the account entry after native rebuild and use fixed destinations', async()=>{
  const handlers=new Map(), visited=[], clipboard=[], messages=[], errors=[];
  let current=null, response=2, browserError=false;
  const Menu={getApplicationMenu:()=>current,setApplicationMenu(menu){current=menu;},buildFromTemplate:items=>({items})};
  const original=Menu.setApplicationMenu;
  const host=attachNativeHelpMenu(Menu,()=>{},{id:'workbaby-help-accounts',label:'账号切换'});
  const app=attachDesktopCommunity({Menu,
    ipcMain:{handle:(channel,action)=>handlers.set(channel,action),removeHandler:channel=>handlers.delete(channel)},
    clipboard:{writeText:text=>clipboard.push(text)},
    dialog:{async showMessageBox(options){messages.push(options);return {response};},showErrorBox:(title,message)=>errors.push({title,message})},
    shell:{async openExternal(url){if(browserError)throw Error('browser not available');visited.push(url);}}
  }, event=>{if(!event.official)throw Error('untrusted_frame');});
  for (let i=0;i<2;i++) {
    const help={items:[],append(item){this.items.push(item);}};
    const menu={items:[{role:'help',submenu:help}]};
    Menu.setApplicationMenu(menu);Menu.setApplicationMenu(menu);
    assert.deepEqual(help.items.map(item=>item.label),['账号切换','胖胖熊·交流群','赞助商 · novecloud']);
  }
  const group=handlers.get('workbaby-open-community');
  const sponsor=handlers.get('workbaby-open-sponsor');
  assert.throws(()=>group({official:false}),/untrusted_frame/);
  assert.throws(()=>sponsor({official:false}),/untrusted_frame/);
  assert.equal(visited.length,0);
  await group({official:true},'https://example.invalid');
  response=0;await sponsor({official:true});
  assert.deepEqual(visited,['https://qm.qq.com/q/qE3D6p3cti','https://n.novecd.com/']);
  assert.match(messages[0].detail,/新人首月送 200G 流量免费体验/);
  assert.match(messages[0].detail,/555657982/);
  response=1;await sponsor({official:true});
  assert.deepEqual(clipboard,['555657982']);
  await current.items[0].submenu.items[1].click();
  assert.equal(visited.at(-1),'https://qm.qq.com/q/qE3D6p3cti');
  browserError=true;await group({official:true});
  assert.match(errors[0].message,/794944238/);
  app.dispose();host.dispose();
  assert.equal(handlers.size,0);
  assert.equal(Menu.setApplicationMenu,original);
});
