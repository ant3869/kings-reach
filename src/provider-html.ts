// src/provider-html.ts - local-only model routing control page. No credentials are rendered or accepted here.
// Providers and models are DROPDOWNS fed by /api/providers `choices` (live catalog + health checks): a typo or a
// mismatched pair (e.g. a ChatGPT model under the Claude route) cannot be selected, and the server re-checks on save.

import { SHELL_CSS, pageHead, wrapInShell } from './shell.js';
import { TIERS_CSS, TIERS_JS, TIERS_PANEL } from './tiers-html.js';

// Page-specific rules only: palette, rail and the shared button/notice/input kit come from shell.ts.
const CSS = `
:root{--ac:#c7a44b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.45 system-ui,sans-serif;min-height:100vh}
.workspace{max-width:1240px;padding:26px 32px 24px}
h2{margin:26px 0 10px;font:600 11px system-ui;color:var(--faint);letter-spacing:1.2px;text-transform:uppercase}
.hint{color:var(--dim);font-size:13px;margin:0 0 14px;max-width:80ch;line-height:1.55}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0 0}
.stat{position:relative;border:1px solid var(--line);border-radius:4px;background:var(--card);padding:12px 14px 11px;overflow:hidden}
.stat:before{content:'';position:absolute;left:0;top:0;right:0;height:2px;background:linear-gradient(90deg,var(--acc),transparent 70%);opacity:.7}
.stat b{display:block;font:500 26px/1.2 Georgia,serif;font-variant-numeric:tabular-nums}
.stat span{color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:1px}
.providers{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.provider{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:13px 14px;display:flex;flex-direction:column;gap:6px}
.provider>b{font:600 14px Georgia,serif;letter-spacing:.2px}
.provider>div:not(.chips):not(.status):not(.hint){color:var(--dim);font-size:12.5px;line-height:1.45}
.provider.ok{border-top:2px solid var(--green)}.provider.bad{border-top:2px solid var(--red)}
.chips{display:flex;gap:5px;flex-wrap:wrap}
.chip{font:600 9.5px system-ui;letter-spacing:.9px;color:var(--faint);border:1px solid var(--line);border-radius:3px;padding:2px 7px}
.status{display:flex;align-items:flex-start;gap:7px;font-size:12px;margin-top:auto;padding-top:8px;border-top:1px solid var(--rule)}
.sdot{flex:none;width:7px;height:7px;margin-top:5px;border-radius:50%;background:var(--faint)}
.ok .status{color:var(--green)}.ok .sdot{background:var(--green)}.bad .status{color:var(--red)}.bad .sdot{background:var(--red)}
.provider .hint{margin:0;font-size:11.5px;color:var(--faint)}
.roles{display:grid;gap:12px;padding-bottom:18px}
.role{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--ac);border-radius:4px;padding:14px 16px}
.rolehead{display:grid;grid-template-columns:170px 1fr;gap:16px;padding-bottom:10px;margin-bottom:4px;border-bottom:1px solid var(--rule)}
.rolehead b{font:600 13px Georgia,serif;letter-spacing:1.5px;color:var(--ac)}
.tier{color:var(--amber);font-size:12px;margin-top:2px}
.rolehead .hint{margin:3px 0 0;font-size:12px}
.route{display:grid;grid-template-columns:24px 250px 1fr 84px;gap:8px;align-items:center;margin-top:8px}
.route>span{color:var(--faint);font-variant-numeric:tabular-nums;text-align:right}
.route select{width:100%}
.route select.invalid{border-color:var(--red);color:var(--red)}
.add{margin-top:12px}
.warn{color:var(--amber);font-size:12px;margin:4px 0 0 32px}
.actions{position:sticky;bottom:0;display:flex;gap:10px;align-items:center;margin:0 -32px;padding:12px 32px;background:#090b0ef2;border-top:1px solid var(--line);backdrop-filter:blur(8px)}
.msg{color:var(--dim);font-size:13px}.msg.bad{color:var(--amber)}
@media(max-width:820px){.workspace{padding:18px 14px}.actions{margin:0 -14px;padding:12px 14px}.rolehead{grid-template-columns:1fr}.route{grid-template-columns:22px 1fr}.route select.model{grid-column:2}.route .remove{grid-column:2}}
`;

export function renderProviderSettings(token = ''): string {
  const safeToken = JSON.stringify(token).replace(/</g, '\\u003c');
  const body = `<div class="workspace">
${pageHead('Alliances & Routes', 'Provider Network', 'Mix labs, subscriptions, APIs and local models across the council.')}
<div class="notice"><b>Capability-aware fallback:</b> execution and investigation marked “tools required” automatically skip direct ChatGPT/Meta/9Router, Gemini, OpenAI API, OpenRouter and Ollama routes in this implementation. Claude SDK, Codex CLI, OpenClaw, Hermes and Code Puppy can operate on the repository. Advisory stages can use any configured provider.</div>
<div id="summary" class="summary"></div>
<h2>Allied providers</h2>
<div id="providers" class="providers"><div class="provider">Checking providers...</div></div>
${TIERS_PANEL}
<h2>Role assignments</h2><p class="hint">Routes run left-to-right. Pick a provider, then one of ITS models: the lists come from the live checks, and providers that are not set up are greyed out. A quota/auth/model failure moves to the next compatible route. Changes affect the next agent call; no restart required.</p>
<div id="roles" class="roles"></div>
<div class="actions"><button class="btn primary" id="save">Save routing</button><button class="btn" id="reset">Recommended defaults</button><span id="msg" class="msg"></span></div>
</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Provider Network - King's Reach</title><style>${SHELL_CSS}${CSS}${TIERS_CSS}</style></head><body>
${wrapInShell('settings', token, body)}
<script>
var TOKEN=${safeToken};var ROLE_COLOR={main:'#d4a017',research:'#79c0ff',comms:'#a371f7',content:'#3fb950',ops:'#f85149'};var state=null;var dirty=false;var defs=[];var guide={};var choices={};var ranked={};var ready={};
function h(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function headers(write){var x={};if(TOKEN)x['x-kings-reach-token']=TOKEN;if(write)x['Content-Type']='application/json';return x}
async function api(path,opt){var r=await fetch(path,Object.assign({headers:headers(Boolean(opt))},opt||{}));var b=await r.json();if(!r.ok)throw Error(b.error||('HTTP '+r.status));return b}
function isReady(p){return ready[p]===true}
function modelsOf(p){return choices[p]||[]}
function firstModel(p){var l=modelsOf(p);return l.length?l[0].id:''}
function firstReadyProvider(){var d=defs.find(function(x){return isReady(x.id)&&modelsOf(x.id).length});return d?d.id:'claude'}
function providerOptions(selected){return defs.map(function(d){var ok=isReady(d.id);return '<option value="'+h(d.id)+'"'+(d.id===selected?' selected':'')+(ok||d.id===selected?'':' disabled')+'>'+h(d.name)+(ok?'':' (not available)')+'</option>'}).join('')}
function modelSelect(p,model){var list=modelsOf(p);var known=list.some(function(m){return m.id===model});var opts=list.map(function(m){return '<option value="'+h(m.id)+'"'+(m.id===model?' selected':'')+'>'+h(m.id)+(m.note?'  -  '+h(m.note):'')+'</option>'}).join('');if(model&&!known)opts='<option value="'+h(model)+'" selected>&#9888; '+h(model)+' (not a valid '+h(p)+' model - pick another)</option>'+opts;if(!opts)opts='<option value="">no models available</option>';return '<select class="model'+(model&&!known?' invalid':'')+'">'+opts+'</select>'}
function routeRow(agent,r,i){var d=defs.find(function(x){return x.id===r.provider});var warning=d&&!d.tools&&['main','ops'].includes(agent)?'<div class="warn">Tool-less: advisory only for this role.</div>':'';return '<div class="route" data-i="'+i+'"><span title="'+(i?'Fallback: used only if the route above fails':'Primary route: tried first')+'">'+(i+1)+'.</span><select class="prov">'+providerOptions(r.provider)+'</select>'+modelSelect(r.provider,r.model)+'<button class="btn danger remove">Remove</button></div>'+warning}
function renderRoles(){var box=document.getElementById('roles');box.innerHTML=Object.keys(state.agents).map(function(id){var g=guide[id]||{};return '<section class="role" data-agent="'+h(id)+'" style="--ac:'+(ROLE_COLOR[id]||'#c7a44b')+'"><div class="rolehead"><div><b>'+h(id.toUpperCase())+'</b><div class="tier">'+h(g.tier||'Custom role')+'</div></div><div><div>'+h(g.strengths||'')+'</div><div class="hint">'+h(g.tolerate||'')+'</div></div></div><div class="routes">'+state.agents[id].map(function(r,i){return routeRow(id,r,i)}).join('')+'</div><button class="btn add">+ fallback</button></section>'}).join('')}
function readRoles(){document.querySelectorAll('.role').forEach(function(role){var id=role.dataset.agent;state.agents[id]=Array.from(role.querySelectorAll('.route')).map(function(row){return {provider:row.querySelector('select.prov').value,model:row.querySelector('select.model').value}})})}
${TIERS_JS}
function summarize(x){var ok=x.health.filter(function(v){return v.available}).length;var tools=defs.filter(function(d){var s=x.health.find(function(v){return v.id===d.id})||{};return d.tools&&s.available}).length;var agents=Object.keys(state.agents);var deep=agents.filter(function(id){return state.agents[id].length>1}).length;document.getElementById('summary').innerHTML=[[ok+' / '+defs.length,'providers ready'],[tools,'can run tools'],[agents.length,'roles routed'],[deep+' / '+agents.length,'have a fallback']].map(function(p){return '<div class="stat"><b>'+h(p[0])+'</b><span>'+h(p[1])+'</span></div>'}).join('')}
function problems(){var n=0;Object.keys(state.agents).forEach(function(id){state.agents[id].forEach(function(r){if(!isReady(r.provider)||!modelsOf(r.provider).some(function(m){return m.id===r.model}))n++})});return n}
function note(){var m=document.getElementById('msg');var n=problems();m.className='msg'+(n?' bad':'');m.textContent=n?n+' route(s) marked in red use a provider or model that is not available. Pick a valid one, then Save.':(dirty?'\\u25cf Unsaved changes. Press Save routing to apply.':'')}
function bind(){document.getElementById('roles').onclick=function(e){var role=e.target.closest('.role');if(!role)return;var id=role.dataset.agent;if(e.target.classList.contains('add')){dirty=true;readRoles();var p=firstReadyProvider();state.agents[id].push({provider:p,model:firstModel(p)});renderRoles();note()}if(e.target.classList.contains('remove')){dirty=true;readRoles();var i=Number(e.target.closest('.route').dataset.i);if(state.agents[id].length>1)state.agents[id].splice(i,1);renderRoles();note()}};document.getElementById('roles').onchange=function(e){var row=e.target.closest('.route');if(!row)return;dirty=true;if(e.target.classList.contains('prov'))row.querySelector('select.model').outerHTML=modelSelect(e.target.value,firstModel(e.target.value));readRoles();renderRoles();note()};document.getElementById('save').onclick=async function(){readRoles();readTiers();var m=document.getElementById('msg');m.className='msg';m.textContent='saving...';try{state=await api('/api/providers/config',{method:'PUT',body:JSON.stringify(state)});renderRoles();renderTiers();dirty=false;m.className='msg';m.textContent='Saved. New calls use this routing.'}catch(e){m.className='msg bad';m.textContent=e.message}};document.getElementById('reset').onclick=async function(){var x=await api('/api/providers/defaults');var keep=state.tiers;state=x.config;if(keep)state.tiers=keep;dirty=true;renderRoles();renderTiers();note();if(!problems())document.getElementById('msg').textContent='Defaults loaded; press Save to apply.'}}
async function load(){try{var x=await api('/api/providers');state=x.config;defs=x.providers;guide=x.guidance;choices=x.choices||{};ranked=x.ranked||{};x.health.forEach(function(v){ready[v.id]=Boolean(v.configured)});document.getElementById('providers').innerHTML=defs.map(function(d){var s=x.health.find(function(v){return v.id===d.id})||{};return '<div class="provider '+(s.available?'ok':'bad')+'"><b>'+h(d.name)+'</b><div class="chips"><span class="chip">'+(d.tools?'TOOLS':'ADVISORY')+'</span><span class="chip">'+(d.local?'LOCAL':'REMOTE')+'</span><span class="chip">JSON</span></div><div>'+h(d.note)+'</div><div class="status"><i class="sdot"></i>'+h(s.detail||'unknown')+'</div><div class="hint">Auth: '+h(d.auth)+'</div></div>'}).join('');summarize(x);renderRoles();renderTiers();bind();bindTiers();note()}catch(e){document.getElementById('providers').innerHTML='<div class="provider bad">'+h(e.message)+'</div>'}}
load();
</script></body></html>`;
}
