const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const NyxSettings = require('../src/settings.js');
const NyxOpenings = require('../src/openings.js');

async function createPopup() {
  const elements = new Map();
  const defaultFor = (id) => ({ id, value: '', textContent: '', disabled: false, hidden: false,
    className: 'primary', tabIndex: 0, classList: { toggle() {} }, style: { setProperty() {} },
    validity: { valid: true }, setAttribute() {}, addEventListener() {}, focus() {} });
  const ids = ['settings','custom-label','eloValue','elo','levelName','eloNote','varietyValue','variety','blundersValue','blunders','adaptive',
    'side','depth','timeMs','delayMs','openingWhite','openingBlack','customLine',
    'tab-play','tab-openings','tab-engine','panel-play','panel-openings','panel-engine',
    'toggle','once','connection','connectionText','turn','phase','status','move','score','metrics','quality','blunderStatus'];
  for (const id of ids) elements.set(id, defaultFor(id));
  for (const [id] of Object.entries(NyxSettings.defaults)) if (!elements.has(id)) elements.set(id, defaultFor(id));
  for (const id of ['openingWhite', 'openingBlack']) elements.get(id).add = () => {};
  const settings = { ...NyxSettings.defaults };
  for (const [id, value] of Object.entries(settings)) elements.get(id).value = value;
  elements.get('elo').min='600';elements.get('elo').max='2250';elements.get('elo').value='1600';
  elements.get('variety').min='0';elements.get('variety').max='100';
  elements.get('blunders').min='0';elements.get('blunders').max='3';elements.get('blunders').value='2';
  for (const id of ['timeMs','delayMs']) elements.get(id).validity={valid:true};
  elements.get('settings').addEventListener=(name,fn)=>{(elements.get('settings').listeners||={})[name]=fn;};
  for (const id of ['toggle','once']) elements.get(id).addEventListener=(name,fn)=>{(elements.get(id).listeners||={})[name]=fn;};
  const tabs=['play','openings','engine'].map(name=>{const el=elements.get(`tab-${name}`);el.dataset={tab:name};el.getAttribute=()=>`panel-${name}`;el.setAttribute=(key,value)=>el[key]=value;el.addEventListener=(event,fn)=>{(el.listeners||={})[event]=fn;};return el;});
  const panels={scrollTop:0};
  const document={hidden:false,querySelectorAll:()=>tabs,getElementById:id=>elements.get(id),querySelector:()=>panels};
  const state={available:true,turn:'w'};
  let running=false, result=null;
  const makeData=()=>({ok:true,settings:{...settings},state:{...state},running,once:false,phase:running?'thinking':'idle',message:running?'Thinking':'Stopped.',result});
  const chrome={tabs:{query:async()=>[{id:1}],sendMessage:async(_id,request)=>{
    if(request.type==='configure')Object.assign(settings,request.settings);
    if(request.type==='start')running=true;
    if(request.type==='stop')running=false;
    return makeData();
  }}};
  const context=vm.createContext({document,chrome,NyxSettings,NyxOpenings,window:{addEventListener(){}},
    setTimeout,clearTimeout,setInterval:fn=>(context.poll=fn,1),clearInterval,Option:class{constructor(text,value){this.text=text;this.value=value;}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../popup/popup.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {context,elements,settings,setResult(value){result=value;}};
}
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};

test('popup polling never overwrites a dirty Elo input, then saves it',async()=>{
  const p=await createPopup();
  const elo=p.elements.get('elo');elo.value='1900';p.elements.get('settings').listeners.input();
  p.context.poll();await flush();assert.equal(elo.value,'1900');
  p.elements.get('settings').listeners.change();await flush();
  assert.equal(p.settings.elo,1900);
});

test('popup start and stop labels follow confirmed state without a false stopping class',async()=>{
  const p=await createPopup(),button=p.elements.get('toggle');
  p.context.poll();await flush();assert.equal(button.textContent,'Start autoplay');
  assert.equal(button.className,'primary');
  p.context.poll();await flush();assert.equal(button.className,'primary');
  button.listeners.click();await flush();assert.equal(button.textContent,'Stop');
  button.listeners.click();await flush();assert.equal(button.textContent,'Start autoplay');
});

test('popup tabs support keyboard arrow navigation',async()=>{
  const p=await createPopup();let prevented=false;
  p.elements.get('tab-play').listeners.keydown({key:'ArrowRight',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(p.elements.get('panel-openings').hidden,false);
  assert.equal(p.elements.get('tab-openings').tabIndex,0);
});

test('popup coach control persists and shows suggestion-specific actions',async()=>{
  const p=await createPopup();
  p.elements.get('control').value='coach';
  p.elements.get('settings').listeners.change();await flush();
  assert.equal(p.settings.control,'coach');
  assert.equal(p.elements.get('toggle').textContent,'Start coach');
  assert.equal(p.elements.get('once').textContent,'Suggest one move');
});

test('popup displays book and estimated search quality labels',async()=>{
  const p=await createPopup();
  p.setResult({move:'e2e4',source:'book',opening:'Italian'});
  await p.context.poll();
  assert.equal(p.elements.get('quality').textContent,'Book');
  p.setResult({move:'d2d4',score:90,depth:8,nodes:1000,time:400,exactScores:true,lines:[{move:'e2e4',score:100}]});
  await p.context.poll();
  assert.equal(p.elements.get('quality').textContent,'Excellent');
  assert.match(p.elements.get('quality').title,/Nyx estimate/);
});
