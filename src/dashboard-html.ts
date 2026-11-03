// src/dashboard-html.ts - Mission Control: chat, missions, memory, hive, war room.
// Bump DASHBOARD_CLIENT_VERSION on every client change (shown in footer + /api/health).

import { CLIENT_MD_JS } from './client-md.js';

export const DASHBOARD_CLIENT_VERSION = 5;
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
function hdrs(extra){var h=extra||{};if(TOKEN)h['x-claudeclaw-token']=TOKEN;return h;}
async function j(p){var r=await fetch(p,{headers:hdrs()});if(!r.ok)throw new Error(p+' (HTTP '+r.status+')');return r.json();}
async function send(method,p,b){var r=await fetch(p,{method:method,headers:hdrs({'Content-Type':'application/json'}),body:b?JSON.stringify(b):undefined});return r.json();}
function byId(id){return document.getElementById(id);}
function ago(ts){var d=Date.now()-Number(ts);if(!(d>=0))return '';var s=Math.floor(d/1000);if(s<60)return s+'s ago';var m=Math.floor(s/60);if(m<60)return m+'m ago';var h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago';}
function empty(text){return '<p class="empty">'+esc(text)+'</p>';}

function renderAgents(a){
  byId('pillagentstext').textContent=a.length+' agents';
  byId('agents').innerHTML=a.map(function(x){return '<span class="agentcard'+(x.id===selAgent?' sel':'')+'" data-action="agent" data-id="'+esc(x.id)+'" data-name="'+esc(x.name)+'">'+esc(x.name)+' <small>'+esc(x.model)+'</small></span>';}).join('');
}
function renderTasks(t){
  byId('tasks').innerHTML=t.length?t.map(function(m){return '<div class="mission"><span class="cron">'+esc(m.schedule)+'</span><span class="st">'+esc(m.status||'active')+'</span><div>'+esc(String(m.prompt||'').slice(0,220))+'</div><div class="meta">'+esc(m.id)+' &middot; '+esc(m.agent_id)+' &middot; '+esc(m.chat_id)+' &middot; next '+(m.next_run?new Date(m.next_run).toLocaleString():'?')+' <button class="ghost small" data-action="del-mission" data-id="'+esc(m.id)+'">delete</button></div></div>';}).join(''):empty('No missions yet. Schedule your first one above; daily briefings live here.');
}
function renderHive(h){
  byId('hive').innerHTML=h.length?h.slice(0,10).map(function(x){return '<div class="hiveitem"><div>'+esc(String(x.summary||x.action_type||'').slice(0,220))+'</div><div class="meta">'+esc(x.agent_id)+' &middot; '+esc(x.action_type)+' &middot; '+ago(x.created_at)+'</div></div>';}).join(''):empty('Empty. Agents log here when they delegate to each other.');
}
function renderMem(m){
  byId('mem').innerHTML=m.length?m.slice(0,20).map(function(x){var imp=Math.max(0,Math.min(1,Number(x.importance)||0));return '<div class="memitem"><div>'+(x.pinned?'Pinned &middot; ':'')+esc(String(x.summary||'').slice(0,200))+'</div><div class="impbar"><i style="width:'+Math.round(imp*100)+'%"></i></div></div>';}).join(''):empty('No memories yet. Chat first; the good stuff gets remembered.');
}
function renderWar(w){
  byId('warstat').textContent=w.running?('running'+(w.pid?' (pid '+w.pid+')':'')):'stopped';
  byId('pillwartext').textContent='war room '+(w.running?'live':'off');
  byId('pillwar').className='pill'+(w.running?' ok':'');
}
var PANELS=[
  {name:'agents',url:'api/agents',render:renderAgents},
  {name:'missions',url:'api/tasks',render:renderTasks},
  {name:'hive mind',url:'api/hive-mind',render:renderHive},
  {name:'memory',url:'api/memories',render:renderMem},
  {name:'war room',url:'api/warroom/status',render:renderWar}
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
.agentcard.sel{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
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
.mission .cron{font-family:monospace;background:#0d1117;border:1px solid var(--line);border-radius:4px;padding:1px 7px;color:var(--gold)}
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
</style></head><body>
<div class="wrap">
<header class="top">
<h1><span class="claw">⬡</span> King's Reach Mission Control</h1>
<span class="pill ok" id="pillagents"><span class="dot"></span><span id="pillagentstext">agents</span></span>
<span class="pill" id="pillwar"><span class="dot"></span><span id="pillwartext">war room</span></span>
<span class="stamp" id="stamp">loading...</span>
<a href="/providers" class="ghost" style="font-size:12px;padding:5px 12px;text-decoration:none">Settings / Models</a>
<button class="ghost" style="font-size:12px;padding:4px 12px" data-action="blur">Privacy blur</button>
</header>
<div class="banner" id="banner" role="alert" hidden></div>
<p class="tip">Tip: type <code>@comms: hello</code> in chat to route to an agent. <a href="/warroom" style="color:var(--blue)">Open the War Room</a> · <a href="/providers" style="color:var(--blue)">Model & provider routing</a></p>

<main>
<section class="s-chat"><h2>Chat</h2>
<div class="agents" id="agents"></div>
<div id="chatlog"><div class="msg agent"><span class="who">Main</span>Hey, I'm online. Ask me anything — I run real Claude on your PC.</div></div>
<div class="composer"><input id="chatmsg" placeholder="Message Main... (Enter to send)"><button id="sendbtn" data-action="send-chat">Send</button></div>
</section>

<section class="s-missions"><h2>Missions</h2>
<div id="tasks"><p class="empty">loading...</p></div>
<div class="formgrid"><strong style="font-size:13px">New mission</strong>
<input id="mprompt" placeholder='Prompt, e.g. &quot;Summarize my inbox&quot;'>
<div class="row"><input id="msched" placeholder="Cron, e.g. 0 9 * * * (daily 9am)"><input id="mchat" placeholder="Chat ID (Telegram /chatid)"></div>
<div><button data-action="create-mission">Schedule</button></div></div>
</section>

<section class="s-hive"><h2>Hive mind</h2><div id="hive"><p class="empty">loading...</p></div></section>
<section class="s-mem"><h2>Memory</h2><div id="mem"><p class="empty">loading...</p></div></section>

<section class="s-war"><h2>War Room</h2>
<p class="tip" style="margin:0 0 8px">Voice council on <code>:7860</code>. <a href="/warroom" style="color:var(--blue)">Enter the War Room</a></p>
<div><button data-action="war-start">Start</button>
<button class="ghost" data-action="war-stop">Stop</button>
<span class="pill" id="warstat" style="margin-left:8px">checking...</span></div></section>
</main>
<footer>King's Reach · Mission Control client v${DASHBOARD_CLIENT_VERSION} · all data stays on this machine</footer>
</div>
<script>
var TOKEN=${JSON.stringify(data.token ?? '').replace(/</g, '\\u003c')};
${CLIENT_MD_JS}
${SCRIPT}
</script></body></html>`;
}
