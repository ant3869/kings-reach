// src/dashboard-html.ts - Mission Control: chat, missions, memory, hive, war room.
// Bump DASHBOARD_CLIENT_VERSION on every client change (shown in footer + /api/health).

import { CLIENT_MD_JS } from './client-md.js';

export const DASHBOARD_CLIENT_VERSION = 6;
const REFRESH_MS = 15_000;
const STALE_MS = 45_000;

export interface DashboardData {
  token?: string;
}

// Plain browser JS. No backticks or backslashes (it lives in a template literal).
// Panels refresh in parallel (allSettled: one failing endpoint never blanks the others);
// failures and staleness are VISIBLE (banner + last-updated stamp), never swallowed.
const SCRIPT = `
var selAgent='main', selName='Main', lastOk=0, failures=[], everOk=false;
var snapshot={agents:0,missions:0,memory:0,hive:0,war:false,tokens:0};
function hdrs(extra){var h=extra||{};if(TOKEN)h['x-kings-reach-token']=TOKEN;return h;}
async function j(p){var r=await fetch(p,{headers:hdrs()});if(!r.ok)throw new Error(p+' (HTTP '+r.status+')');return r.json();}
async function send(method,p,b){var r=await fetch(p,{method:method,headers:hdrs({'Content-Type':'application/json'}),body:b?JSON.stringify(b):undefined});return r.json();}
function byId(id){return document.getElementById(id);}
function ago(ts){var d=Date.now()-Number(ts);if(!(d>=0))return '';var s=Math.floor(d/1000);if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago';}
function empty(text){return '<p class="empty">'+esc(text)+'</p>';}
function compactNumber(n){n=Number(n)||0;if(n>=1000000)return (n/1000000).toFixed(1).replace('.0','')+'m';if(n>=1000)return (n/1000).toFixed(1).replace('.0','')+'k';return String(n);}
function paintFinding(){
  var bits=[];
  if(snapshot.missions)bits.push(snapshot.missions+' active mission'+(snapshot.missions===1?'':'s'));
  if(!snapshot.war)bits.push('War Room offline');
  if(!bits.length)bits.push('All systems ready');
  byId('finding').textContent=bits.join(' · ');
  byId('quickstats').textContent=snapshot.agents+' agents · '+compactNumber(snapshot.tokens)+' tokens / 24h';
}

function renderAgents(a){
  snapshot.agents=a.length;byId('pillagentstext').textContent=a.length+' agents';
  var selected=a.filter(function(x){return x.id===selAgent;})[0];byId('consoleroute').textContent=selected?(selected.name+' · '+selected.model):selName;
  byId('agents').innerHTML=a.map(function(x){return '<button class="agentcard'+(x.id===selAgent?' sel':'')+'" data-action="agent" data-id="'+esc(x.id)+'" data-name="'+esc(x.name)+'" aria-pressed="'+(x.id===selAgent?'true':'false')+'"><span>'+esc(x.name)+'</span><small>'+esc(x.model)+'</small></button>';}).join('');paintFinding();
}
function renderTasks(t){
  snapshot.missions=t.filter(function(m){return (m.status||'active')!=='disabled';}).length;
  byId('tasks').innerHTML=t.length?t.map(function(m){return '<article class="mission"><div class="missiontop"><span class="cron">'+esc(m.schedule)+'</span><span class="st">'+esc(m.status||'active')+'</span></div><div class="missionprompt">'+esc(String(m.prompt||'').slice(0,220))+'</div><div class="meta">'+esc(m.agent_id)+' · next '+(m.next_run?new Date(m.next_run).toLocaleString():'unscheduled')+'</div><button class="textbtn danger" data-action="del-mission" data-id="'+esc(m.id)+'">Delete mission</button></article>';}).join(''):empty('No active missions. Use New mission to schedule the first order.');paintFinding();
}
function renderHive(h){
  snapshot.hive=h.length;byId('hive').innerHTML=h.length?h.slice(0,6).map(function(x){return '<article class="ledgeritem"><div>'+esc(String(x.summary||x.action_type||'').slice(0,180))+'</div><div class="meta">'+esc(x.agent_id)+' · '+esc(x.action_type)+' · '+ago(x.created_at)+'</div></article>';}).join(''):empty('No shared-agent activity yet.');
}
function renderMem(m){
  snapshot.memory=m.length;byId('memcount').textContent=m.length+' stored';
  byId('mem').innerHTML=m.length?m.slice(0,8).map(function(x){var score=Math.round(Math.max(0,Math.min(1,Number(x.importance)||0))*100);return '<article class="memoryitem"><div class="memorycopy">'+(x.pinned?'<span class="pinlabel">Pinned</span> ':'')+esc(String(x.summary||'').slice(0,165))+'</div><div class="meta">Recall priority '+score+'/100 · '+ago(x.created_at)+'</div></article>';}).join(''):empty('No memories yet. Useful conversation details will appear here.');
}
function renderWar(w){
  snapshot.war=!!w.running;byId('warstat').textContent=w.running?('running'+(w.pid?' · pid '+w.pid:'')):'offline';
  byId('pillwartext').textContent='war room '+(w.running?'live':'off');
  byId('pillwar').className='pill'+(w.running?' ok':'');paintFinding();
}
function renderTokens(t){var d=t.daily||{};snapshot.tokens=Number(d.t_in||0)+Number(d.t_out||0);byId('tokenstat').textContent=compactNumber(snapshot.tokens)+' tokens';byId('tokendetail').textContent=compactNumber(d.t_in||0)+' in · '+compactNumber(d.t_out||0)+' out';paintFinding();
}
var PANELS=[
  {name:'agents',url:'api/agents',render:renderAgents},
  {name:'missions',url:'api/tasks',render:renderTasks},
  {name:'hive mind',url:'api/hive-mind',render:renderHive},
  {name:'memory',url:'api/memories',render:renderMem},
  {name:'war room',url:'api/warroom/status',render:renderWar},
  {name:'tokens',url:'api/tokens',render:renderTokens}
];
async function refresh(){
  var results=await Promise.allSettled(PANELS.map(function(p){return j(p.url);}));
  failures=[];
  results.forEach(function(r,i){
    var p=PANELS[i];
    if(r.status!=='fulfilled'){failures.push(p.name+': '+(r.reason&&r.reason.message||'failed'));return;}
    try{p.render(r.value);}catch(e){failures.push(p.name+': render error '+e.message);}
  });
  if(!failures.length){lastOk=Date.now();everOk=true;}
  paintStatus();
}
function paintStatus(){
  var banner=byId('banner'),stamp=byId('stamp'),age=Date.now()-lastOk,msg='';
  if(failures.length===PANELS.length)msg='Core unreachable: is node dist/index.js running? '+(everOk?'Showing data from '+ago(lastOk)+'.':'Nothing loaded yet.');
  else if(failures.length)msg='Some panels failed to refresh: '+failures.join(' | ');
  else if(everOk&&age>${STALE_MS})msg='Data is stale: last successful refresh '+ago(lastOk)+'.';
  banner.textContent=msg;banner.hidden=!msg;
  stamp.textContent=everOk?'updated '+ago(lastOk):'loading...';
  stamp.className='stamp'+(msg?' bad':'');
}

async function sendChat(){
  var inp=byId('chatmsg'),msg=inp.value.trim();if(!msg)return;
  inp.value='';byId('sendbtn').disabled=true;
  var log=byId('chatlog');
  log.insertAdjacentHTML('beforeend','<div class="msg you"><span class="who">You</span>'+md(msg)+'</div>');
  var typing=document.createElement('div');typing.className='msg agent thinking';typing.innerHTML='<span class="who">'+esc(selName)+'</span>thinking...';log.appendChild(typing);log.scrollTop=log.scrollHeight;
  try{
    var r=await send('POST','api/chat',{message:msg,agentId:selAgent,chatId:'dashboard'});
    typing.className='msg agent';typing.innerHTML='<span class="who">'+esc(r.agentId||selName)+'</span>'+md(r.text||r.error||'(no reply)');
  }catch(e){typing.className='msg agent';typing.innerHTML='<span class="who">error</span>'+esc(String(e));}
  byId('sendbtn').disabled=false;log.scrollTop=log.scrollHeight;refresh();
}
async function createMission(){
  var prompt=byId('mprompt').value.trim(),schedule=byId('msched').value.trim(),chatId=byId('mchat').value.trim();
  if(!prompt||!schedule||!chatId){alert('prompt + cron schedule + chat ID required');return;}
  var r=await send('POST','api/tasks',{prompt:prompt,schedule:schedule,chatId:chatId,agentId:selAgent});
  if(r.id){byId('mprompt').value='';alert('Scheduled: '+r.id);}else alert('Error: '+(r.error||'unknown'));
  refresh();
}
var ACTIONS={
  'agent':function(el){selAgent=el.dataset.id;selName=el.dataset.name;byId('chatmsg').placeholder='Message '+selName+'... (Enter to send)';refresh();},
  'del-mission':async function(el){if(!confirm('Delete mission '+el.dataset.id+'?'))return;await send('DELETE','api/tasks/'+encodeURIComponent(el.dataset.id));refresh();},
  'war-start':async function(el){el.disabled=true;var r=await send('POST','api/warroom/start');if(!r.ok)alert('War room: '+(r.error||'failed'));el.disabled=false;refresh();},
  'war-stop':async function(el){var r=await send('POST','api/warroom/stop');if(!r.ok)alert('War room: '+(r.error||'failed'));refresh();},
  'send-chat':sendChat,
  'create-mission':createMission,
  'blur':function(){document.body.classList.toggle('blur');}
};
document.addEventListener('click',function(e){var el=e.target.closest('[data-action]');if(el&&ACTIONS[el.dataset.action])ACTIONS[el.dataset.action](el);});
byId('chatmsg').addEventListener('keydown',function(e){if(e.key==='Enter')sendChat();});
refresh();setInterval(refresh,${REFRESH_MS});setInterval(paintStatus,1000);
`;

/** Complete Mission Control page. Single column, readable type, markdown replies. */
export function renderDashboard(data: DashboardData = {}): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>King's Reach Mission Control v${DASHBOARD_CLIENT_VERSION}</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#30363d;--txt:#e6edf3;--dim:#8b949e;--acc:#3fb950;--blue:#79c0ff;--gold:#d4a017;--red:#f85149}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,sans-serif;margin:0;padding:20px;font-size:15px;line-height:1.6}
.wrap{max-width:920px;margin:0 auto}
header.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
header.top h1{font-size:28px;margin:0;flex:1;font-weight:800;letter-spacing:-0.5px;color:var(--txt)}
header.top h1 span.claw{color:var(--acc)}
.pill{font-size:12px;border:1px solid var(--line);border-radius:20px;padding:3px 12px;color:var(--dim)}
.pill.ok{color:var(--acc);border-color:var(--acc)}
.pill .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dim);margin-right:6px}
.pill.ok .dot{background:var(--acc)}
.tip{font-size:13px;color:var(--dim);margin:4px 0 0}
.tip code{color:var(--blue)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0;border-left:3px solid var(--line)}
section.s-chat{border-left:3px solid var(--acc);padding:20px}
section.s-missions{border-left:3px solid var(--gold)}
section.s-hive{border-left:3px solid #7ee787}
section.s-mem{border-left:3px solid var(--blue)}
section.s-war{border-left:3px solid var(--red)}
section h2{font-size:15px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 12px}
.agents{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.agentcard{border:1px solid var(--line);border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;background:var(--bg)}
.agentcard small{color:var(--dim)}
.agentcard.sel{border-color:var(--acc)}
#chatlog{display:flex;flex-direction:column;gap:10px;max-height:380px;overflow-y:auto;margin-bottom:12px}
.msg{max-width:85%;padding:9px 13px;border-radius:12px;font-size:14px;line-height:1.55}
.msg p{margin:6px 0}.msg p:first-child{margin-top:0}.msg p:last-child{margin-bottom:0}
.msg ul{margin:6px 0;padding-left:22px}.msg pre{background:#0d1117;border:1px solid var(--line);border-radius:6px;padding:8px;overflow-x:auto;font-size:12px}
.msg code{background:#0d1117;padding:1px 5px;border-radius:4px;font-size:13px}
.msg a{color:var(--blue)}
.msg.you{align-self:flex-end;background:#1c3d2a;border:1px solid #2ea043}
.msg.you .who{color:var(--acc)}
.msg.agent{align-self:flex-start;background:#1c2733;border:1px solid var(--line)}
.msg.agent .who{color:var(--blue)}
.msg .who{font-size:12px;font-weight:700;display:block;margin-bottom:2px}
.msg.thinking{opacity:.7;font-style:italic}
.composer{display:flex;gap:8px}
input,select{background:#0d1117;color:var(--txt);border:1px solid var(--line);border-radius:8px;padding:9px 12px;font-size:14px}
.composer input{flex:1}
button{background:#238636;color:#fff;border:0;border-radius:8px;padding:9px 18px;font-size:14px;cursor:pointer}
button:hover{background:#2ea043}
button:disabled{opacity:.5}
button.ghost{background:transparent;border:1px solid var(--line)}
.mission{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0;font-size:13px}
.mission .cron{font-family:inherit;background:#0d1117;border:1px solid var(--line);border-radius:4px;padding:1px 7px;color:var(--gold)}
.mission .st{font-size:11px;border:1px solid var(--acc);color:var(--acc);border-radius:10px;padding:1px 8px;margin-left:6px}
.formgrid{display:grid;gap:8px;margin-top:10px}
.formgrid .row{display:flex;gap:8px}.formgrid .row input{flex:1}
.empty{color:var(--dim);font-style:italic;font-size:13px}
.hiveitem{border-left:3px solid var(--gold);padding:6px 10px;margin:8px 0;font-size:13px;background:#0d1117;border-radius:0 6px 6px 0}
.hiveitem .meta{font-size:11px;color:var(--dim)}
.memitem{padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
.memitem:last-child{border-bottom:0}
.impbar{height:4px;background:#0d1117;border-radius:2px;margin-top:5px}
.impbar i{display:block;height:100%;background:var(--gold);border-radius:2px}
footer{color:var(--dim);font-size:12px;text-align:center;margin:20px 0}
footer a{color:var(--blue)}
.blur main{filter:blur(6px)}
.banner{background:#3a1d1d;border:1px solid #f85149;color:#ffb4ab;border-radius:10px;padding:10px 14px;margin:10px 0;font-size:14px}
.stamp{font-size:12px;color:var(--dim)}
.stamp.bad{color:#f85149}
.meta{font-size:11px;color:var(--dim)}
button.small{font-size:11px;padding:2px 10px}
.msg ol,.msg ul{margin:5px 0;padding-left:20px}
/* Taste Skill app direction: data-terminal, seed 35466346. Operational screen, not a landing page. */
:root{--bg:#090b0e;--rail:#0c0f12;--card:#101317;--raised:#15191e;--line:#292e34;--rule:#20252a;--txt:#e8e3d7;--dim:#a5a7a3;--faint:#989c9b;--acc:#c7a44b;--blue:#b8c6d1;--green:#79c291;--red:#e57982;--control:#d5d7d5}
body{background:var(--bg);color:var(--txt);margin:0;padding:0;font-size:14px;line-height:1.45;overflow-x:hidden}
.wrap{max-width:none;margin:0}.shell{min-height:100vh;display:grid;grid-template-columns:190px minmax(0,1fr)}
.rail{position:sticky;top:0;height:100vh;background:var(--rail);border-right:1px solid var(--line);padding:24px 18px 18px;display:flex;flex-direction:column;z-index:5}
.brand{display:flex;align-items:center;gap:10px;color:var(--txt);text-decoration:none;margin-bottom:34px}.seal{width:34px;height:34px;border:1px solid var(--acc);display:grid;place-items:center;font:700 12px Georgia;color:var(--acc)}.brand strong{font:600 15px Georgia;letter-spacing:.3px}.brand small{display:block;color:var(--dim);font:11px system-ui;letter-spacing:.3px;margin-top:2px}
.nav{display:flex;flex-direction:column;gap:3px}.nav a{position:relative;color:var(--dim);text-decoration:none;padding:10px 9px;font-size:13px;border:0}.nav a:hover,.nav a:focus-visible{color:var(--txt)}.nav a.active{color:var(--txt)}.nav a.active:before{content:'';position:absolute;left:-18px;top:9px;bottom:9px;width:1px;background:var(--acc)}
.railfoot{margin-top:auto;color:var(--faint);font-size:11px;line-height:1.5}.privacy{margin-top:12px;width:100%}
.workspace{min-width:0;padding:25px 32px 30px}.commandhead{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:18px}.commandhead h1{font:500 24px/1.2 Georgia;margin:4px 0 6px;color:var(--txt)}.finding{font-size:14px;color:var(--txt)}.quickstats{font-variant-numeric:tabular-nums;color:var(--dim);font-size:12px;margin-top:4px}.headmeta{text-align:right;min-width:160px}.headmeta .stamp{display:block;margin-bottom:5px}.headlinks{display:flex;gap:12px;justify-content:flex-end}.headlinks a{color:var(--dim);font-size:12px;text-decoration:none}.headlinks a:hover{color:var(--txt)}
.banner{border-radius:3px;margin:0 0 16px;background:#211417;border:1px solid #6e343a;color:#f0b8bd}
.dashboard{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(300px,.75fr);gap:16px;align-items:start}.primary,.intel{display:flex;flex-direction:column;gap:16px}
section{margin:0;padding:15px 16px;background:var(--card);border:1px solid var(--line);border-left:1px solid var(--line);border-radius:4px;box-shadow:none}section.s-chat,section.s-missions,section.s-hive,section.s-mem,section.s-war{border-left:1px solid var(--line);padding:15px 16px}
.sectionhead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}.sectionhead h2,section h2{font-size:13px;letter-spacing:.15px;color:var(--txt);margin:0;font-weight:600}.sectionhead span{font-size:12px;color:var(--faint)}
.systemrows{display:grid}.systemrow{display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--rule)}.systemrow:last-child{border:0}.systemrow>span:first-child{color:var(--dim);font-size:13px}.systemvalue{font-variant-numeric:tabular-nums;color:var(--txt);font-size:13px}.tokenvalue{display:flex;flex-direction:column;align-items:flex-end;min-width:0}.waractions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:12px}
.pill{border:0;border-radius:0;padding:0;color:var(--dim);font-size:12px}.pill.ok{color:var(--green);border:0}.pill .dot{width:6px;height:6px}.pill.ok .dot{background:var(--green)}
.agents{display:grid;grid-template-columns:1fr;gap:0;margin:0}.agentcard{width:100%;display:grid;grid-template-columns:1fr;gap:2px;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--rule);border-radius:0;padding:9px 4px;color:var(--txt);min-height:48px}.agentcard:last-child{border-bottom:0}.agentcard small{color:var(--dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.agentcard.sel{border-color:var(--rule);box-shadow:none;color:var(--txt);position:relative}.agentcard.sel:before{content:'';position:absolute;left:-17px;top:10px;bottom:10px;width:1px;background:var(--acc)}
#chatlog{max-height:300px;margin:0 0 12px;gap:8px}.msg{border-radius:3px;padding:8px 10px;max-width:90%;font-size:13px}.msg.you{background:var(--raised);border:1px solid var(--line)}.msg.you .who{color:var(--txt)}.msg.agent{background:#0c1014;border:1px solid var(--rule)}.msg.agent .who{color:var(--blue)}
.composer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}input,select{width:100%;background:#0a0d10;color:var(--txt);border:1px solid var(--line);border-radius:3px;padding:10px 11px;font-size:13px;min-height:42px}label{display:block;color:var(--dim);font-size:11px;margin:0 0 5px}
button,.buttonlink{background:var(--control);color:#0a0c0f;border:1px solid var(--control);border-radius:3px;padding:9px 14px;font-size:13px;cursor:pointer;min-height:42px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}button:hover,.buttonlink:hover{background:#fff;border-color:#fff}button.ghost,.buttonlink.ghost{background:transparent;color:var(--txt);border:1px solid var(--line)}button.ghost:hover,.buttonlink.ghost:hover{border-color:var(--dim)}button:disabled{opacity:.45;cursor:not-allowed}
.mission{position:relative;border:0;border-bottom:1px solid var(--rule);border-radius:0;padding:11px 0;margin:0;font-size:13px}.mission:last-child{border-bottom:0}.missiontop{display:flex;align-items:center;gap:8px;margin-bottom:5px}.mission .cron{font-family:inherit;font-variant-numeric:tabular-nums;background:transparent;border:0;border-radius:0;padding:0;color:var(--txt)}.mission .st{font-size:11px;border:0;color:var(--green);border-radius:0;padding:0;margin-left:auto;text-transform:uppercase}.missionprompt{padding-right:80px}.textbtn{min-height:auto;background:transparent!important;border:0!important;color:var(--dim)!important;padding:3px 0;font-size:12px}.textbtn.danger{position:absolute;right:0;bottom:10px}.textbtn.danger:hover{color:var(--red)!important}
.missioncreate{border-top:1px solid var(--line);margin-top:10px;padding-top:10px}.missioncreate summary{cursor:pointer;color:var(--txt);font-size:12px}.formgrid{margin-top:12px}.formgrid .row{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field{min-width:0}.formactions{margin-top:10px}
.ledgeritem,.memoryitem{padding:9px 0;border-bottom:1px solid var(--rule);font-size:13px}.ledgeritem:last-child,.memoryitem:last-child{border-bottom:0}.memorycopy{line-height:1.45}.pinlabel{color:var(--acc);font-size:11px;letter-spacing:.2px}.meta{font-size:11px;color:var(--faint);margin-top:4px}.empty{font-style:normal;margin:8px 0;color:var(--dim)}
.hint{color:var(--faint);font-size:12px;margin:8px 0 0}.hint code{color:var(--blue)}.consolemeta{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--rule);padding-top:8px;margin-top:9px;color:var(--faint);font-size:12px}.consolemeta span:last-child{color:var(--txt);font-variant-numeric:tabular-nums}.memorycopy,.ledgeritem{overflow-wrap:anywhere;padding-right:12px}footer{text-align:left;border-top:1px solid var(--line);padding-top:16px;margin:22px 0 0;color:var(--faint);font-size:12px}.s-mem #mem{max-height:238px;overflow:auto;padding-right:3px}.blur .workspace{filter:blur(6px)}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
@media(max-width:1100px){.shell{grid-template-columns:150px minmax(0,1fr)}.rail{padding-left:18px;padding-right:18px}.nav a.active:before{left:-18px}.workspace{padding:22px}}
@media(max-width:980px){.dashboard{grid-template-columns:1fr}.intel{display:flex}.s-mem #mem{max-height:280px}}
@media(max-width:760px){.shell{display:block}.rail{position:sticky;height:auto;padding:10px 16px;display:grid;grid-template-columns:auto 1fr;align-items:center;border-right:0;border-bottom:1px solid var(--line)}.brand{margin:0}.brand strong,.brand small,.railfoot{display:none}.seal{width:32px;height:32px}.nav{display:flex;flex-direction:row;justify-content:flex-end;overflow-x:auto}.nav a{padding:9px 8px;font-size:11px;white-space:nowrap}.nav a.active:before{left:8px;right:8px;top:auto;bottom:3px;width:auto;height:1px}.privacy{display:none}.workspace{padding:16px}.commandhead{display:block}.headmeta{text-align:left;margin-top:10px}.headlinks{justify-content:flex-start}.dashboard{display:flex;flex-direction:column}.primary,.intel{display:contents}.s-system{order:1}.s-chat{order:2}.s-missions{order:3}.s-agents{order:4}.s-mem{order:5}.s-hive{order:6}.formgrid .row{grid-template-columns:1fr}.missionprompt{padding-right:0}.textbtn.danger{position:static;margin-top:4px}.composer{grid-template-columns:1fr}.composer button{width:100%}}
</style></head><body>
<div class="wrap shell">
<aside class="rail" aria-label="Mission Control navigation">
<a class="brand" href="/"><span class="seal">KR</span><span><strong>King's Reach</strong><small>Mission Control</small></span></a>
<nav class="nav"><a class="active" href="#command">Command</a><a href="#missions">Missions</a><a href="#memory">Memory</a><a href="/warroom">War Room</a><a href="/history">Plan Library</a><a href="/providers">Models</a></nav>
<div class="railfoot">Local command surface<br>Client v${DASHBOARD_CLIENT_VERSION}<button class="ghost privacy" data-action="blur">Privacy blur</button></div>
</aside>
<div class="workspace">
<header class="commandhead" id="command">
<div><h1>Command</h1><div class="finding" id="finding">Loading system state...</div><div class="quickstats" id="quickstats">Awaiting telemetry</div></div>
<div class="headmeta"><span class="stamp" id="stamp">loading...</span><div class="headlinks"><a href="/warroom">Enter War Room</a><a href="/history">Plan Library</a><a href="/providers">Provider routing</a></div></div>
</header>
<div class="banner" id="banner" role="alert" hidden></div>
<main class="dashboard">
<div class="primary">
<section class="s-chat" aria-labelledby="chat-title"><div class="sectionhead"><h2 id="chat-title">Command console</h2><span>Enter to send</span></div>
<div id="chatlog" aria-live="polite"><div class="msg agent"><span class="who">Main</span>Online. Issue an order or ask for analysis.</div></div>
<div class="composer"><label class="sr" for="chatmsg">Message selected agent</label><input id="chatmsg" placeholder="Message Main..."><button id="sendbtn" data-action="send-chat">Send</button></div>
<p class="hint">Route explicitly with <code>@comms:</code>, <code>@research:</code>, or another agent name.</p><div class="consolemeta"><span>Selected route</span><span id="consoleroute">Main</span></div></section>
<section class="s-missions" id="missions" aria-labelledby="missions-title"><div class="sectionhead"><h2 id="missions-title">Active missions</h2><span>Ordered by next run</span></div>
<div id="tasks"><p class="empty">Loading missions...</p></div>
<details class="missioncreate"><summary>New mission</summary><div class="formgrid">
<div class="field"><label for="mprompt">Order</label><input id="mprompt" placeholder="Summarize my inbox"></div>
<div class="row"><div class="field"><label for="msched">Cron schedule</label><input id="msched" placeholder="0 9 * * *"></div><div class="field"><label for="mchat">Destination chat ID</label><input id="mchat" value="dashboard" placeholder="dashboard"></div></div>
<div class="formactions"><button data-action="create-mission">Schedule mission</button></div></div></details></section>
<section class="s-hive"><div class="sectionhead"><h2>Hive activity</h2><span>Latest shared actions</span></div><div id="hive"><p class="empty">Loading activity...</p></div></section>
</div>
<aside class="intel" aria-label="System intelligence">
<section class="s-system"><div class="sectionhead"><h2>System readiness</h2><span id="pillwar"><span class="dot"></span><span id="pillwartext">war room</span></span></div>
<div class="systemrows"><div class="systemrow"><span>Agent network</span><span class="systemvalue" id="pillagents"><span class="dot"></span><span id="pillagentstext">loading</span></span></div>
<div class="systemrow"><span>War Room</span><span class="systemvalue" id="warstat">checking...</span></div>
<div class="systemrow"><span>24h usage</span><span class="tokenvalue"><span class="systemvalue" id="tokenstat">loading</span><span class="meta" id="tokendetail"></span></span></div></div>
<div class="waractions"><a class="buttonlink" href="/warroom">Enter</a><button class="ghost" data-action="war-start">Start</button><button class="ghost" data-action="war-stop">Stop</button></div></section>
<section class="s-agents"><div class="sectionhead"><h2>Agent roster</h2><span>Select console route</span></div><div class="agents" id="agents"></div></section>
<section class="s-mem" id="memory"><div class="sectionhead"><h2>Memory</h2><span id="memcount">loading</span></div><div id="mem"><p class="empty">Loading memory...</p></div></section>
</aside>
</main>
<footer>King's Reach operates locally. Provider calls follow your configured routes.</footer>
</div></div>
<script>
var TOKEN=${JSON.stringify(data.token ?? '').replace(/</g, '\\u003c')};
${CLIENT_MD_JS}
${SCRIPT}
</script></body></html>`;
}
