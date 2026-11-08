// src/tiers-html.ts - the "Difficulty tiers" panel on the Settings page. Three model pickers (high / mid / low), an
// on/off switch and a role filter. Its script shares the page's globals (state, defs, choices, h, providerOptions,
// modelSelect, firstModel), so the dropdowns, availability greying and validation behave exactly like the role routes.

export const TIERS_CSS = `
.tiers{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--gold,#c7a44b);border-radius:4px;padding:14px 16px;margin-bottom:6px}
.tiers.off .trow,.tiers.off .tscope{opacity:.55}
.tswitch{display:flex;gap:10px;align-items:center;font-weight:600;cursor:pointer}
.tswitch input,.tchk input{accent-color:var(--gold,#c7a44b);width:16px;height:16px}
.tiers .hint{margin:8px 0 4px}
.trow{display:grid;grid-template-columns:120px 250px 1fr;gap:8px;align-items:center;margin-top:8px}
.trow .tname b{display:block;font:600 13px Georgia,serif;letter-spacing:1px}
.trow .tname small{display:block;color:var(--faint);font-size:11px;line-height:1.35}
.trow select{width:100%}.trow select.invalid{border-color:var(--red);color:var(--red)}
.tscope{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:12px;padding-top:10px;border-top:1px solid var(--rule);color:var(--dim);font-size:13px}
.tchk{display:flex;gap:6px;align-items:center;cursor:pointer}
@media(max-width:820px){.trow{grid-template-columns:1fr}}
`;

export const TIERS_PANEL = `
<h2>Difficulty tiers</h2>
<div id="tiers" class="tiers off"></div>`;

export const TIERS_JS = `
var TIER_INFO={high:['High','Hardest thinking: planning, verdicts, design, tricky bugs'],mid:['Mid','Solid work: investigating, debating, building, reviewing'],low:['Low','Simple chores: recalling, recording, summaries, greetings']};
function pickModel(p,re){var l=modelsOf(p).filter(function(m){return re.test(m.id)});return l.length?l[0].id:firstModel(p)}
function defaultTiers(){return {enabled:false,high:{provider:'claude',model:pickModel('claude',/opus/i)},mid:{provider:'claude',model:pickModel('claude',/sonnet/i)},low:{provider:'claude',model:pickModel('claude',/haiku|sonnet/i)}}}
function tierView(){return state.tiers||defaultTiers()}
function renderTiers(){
  var box=document.getElementById('tiers');if(!box)return;
  var t=tierView(),agents=Object.keys(state.agents),scoped=t.roles||agents;
  var rows=['high','mid','low'].map(function(k){var r=t[k];return '<div class="trow" data-tier="'+k+'"><div class="tname"><b>'+TIER_INFO[k][0]+'</b><small>'+h(TIER_INFO[k][1])+'</small></div><select class="prov">'+providerOptions(r.provider)+'</select>'+modelSelect(r.provider,r.model)+'</div>'}).join('');
  var roles=agents.map(function(id){return '<label class="tchk"><input type="checkbox" data-role="'+h(id)+'"'+(scoped.indexOf(id)>=0?' checked':'')+'> '+h(id)+'</label>'}).join('');
  box.className='tiers'+(t.enabled?'':' off');
  box.innerHTML='<label class="tswitch"><input type="checkbox" id="tiers-on"'+(t.enabled?' checked':'')+'> Pick the model by task difficulty</label>'+
    '<p class="hint">Each step is rated before it runs. Council steps are rated by their job (planning and verdicts are high; investigating, debating, building and reviewing are mid; recalling and recording are low); free-form messages are rated by their wording. The chosen tier\\'s model runs first and the role\\'s own routes below stay behind it as fallbacks.</p>'+rows+
    '<div class="tscope"><b>Applies to:</b>'+roles+'</div>';
}
function readTiers(){
  var box=document.getElementById('tiers');if(!box||!box.querySelector('.trow'))return;
  var on=document.getElementById('tiers-on').checked;
  if(!state.tiers&&!on)return; /* never created: do not send (and have the server validate) untouched defaults */
  var t=state.tiers||defaultTiers();t.enabled=on;
  box.querySelectorAll('.trow').forEach(function(row){t[row.dataset.tier]={provider:row.querySelector('select.prov').value,model:row.querySelector('select.model').value}});
  var all=Object.keys(state.agents),picked=Array.from(box.querySelectorAll('input[data-role]:checked')).map(function(i){return i.dataset.role});
  if(picked.length===all.length)delete t.roles;else t.roles=picked;
  state.tiers=t;
}
function bindTiers(){
  var box=document.getElementById('tiers');if(!box)return;
  box.onchange=function(e){
    var row=e.target.closest('.trow');
    if(row&&e.target.classList.contains('prov'))row.querySelector('select.model').outerHTML=modelSelect(e.target.value,firstModel(e.target.value));
    readTiers();renderTiers();note();
  };
}
`;
