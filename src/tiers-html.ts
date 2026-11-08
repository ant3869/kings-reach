// src/tiers-html.ts - the "Difficulty tiers" panel on the Settings page. One row per provider: pick the weakest model
// you are happy with (Low) and the strongest (High); every model the server ranks in between is allowed by default, and
// can be unticked. A step then lands on the rung its difficulty matches. A role never leaves its own provider.
// The script shares the page's globals (state, defs, choices, ranked, h, isReady, note); the model order comes from the
// server (`ranked`, weakest -> strongest) so the ordering rule lives in exactly one place (model-rank.ts).

export const TIERS_CSS = `
.tiers{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--gold,#c7a44b);border-radius:4px;padding:14px 16px;margin-bottom:6px}
.tiers.off .tgrid,.tiers.off .tscope{opacity:.5}
.tswitch{display:flex;gap:10px;align-items:center;font-weight:600;cursor:pointer}
.tswitch input,.tchk input,.tchip{accent-color:var(--gold,#c7a44b);width:16px;height:16px}
.tiers .hint{margin:8px 0 4px}
.tgrid{margin-top:10px}
.tprow,.tphead{display:grid;grid-template-columns:150px minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr);gap:8px;align-items:start;padding:8px 0;border-top:1px solid var(--rule)}
.tphead{border-top:0;padding:0 0 2px;font:600 11px system-ui;letter-spacing:1.1px;text-transform:uppercase;color:var(--faint)}
.tphead small{display:block;font:11px system-ui;letter-spacing:0;text-transform:none;margin-top:1px}
.tprovname{font:600 13px Georgia,serif;padding-top:6px}
.tprovname small{display:block;font:11px system-ui;color:var(--faint)}
.tprow select{width:100%;min-width:0}.tprow select.invalid{border-color:var(--red);color:var(--red)}
.tbetween{display:flex;flex-wrap:wrap;gap:4px 14px;padding-top:6px;color:var(--dim);font-size:12.5px}
.tbetween label{display:flex;gap:6px;align-items:center;cursor:pointer}
.tbetween .tnone{color:var(--faint)}
.tscope{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:14px;padding-top:10px;border-top:1px solid var(--rule);color:var(--dim);font-size:13px}
.tchk{display:flex;gap:6px;align-items:center;cursor:pointer}
@media(max-width:900px){.tprow{grid-template-columns:1fr}.tphead{display:none}}
`;

export const TIERS_PANEL = `
<h2>Difficulty tiers</h2>
<div id="tiers" class="tiers off"></div>`;

export const TIERS_JS = `
function rankedOf(p){return ranked[p]||[]}
function rangeOf(p,low,high){var l=rankedOf(p),a=l.indexOf(low),b=l.indexOf(high);if(a<0||b<0)return [];return l.slice(Math.min(a,b),Math.max(a,b)+1)}
function defaultTiers(){
  /* Claude only, and only if both families are known: the best Sonnet up to the best Opus. */
  var l=rankedOf('claude'),low=l.filter(function(m){return /sonnet/i.test(m)}).pop(),high=l.filter(function(m){return /opus/i.test(m)}).pop();
  var span=low&&high?rangeOf('claude',low,high):[];
  return {enabled:false,providers:span.length?{claude:span}:{}};
}
function tierView(){return state.tiers||defaultTiers()}
/* What each provider's two dropdowns currently show. A ladder of 0-1 models cannot say which end the user is still choosing, so the dropdowns are remembered here; a ladder of 2+ is always authoritative. */
var tdraft={};
function endsOf(p,ladder){
  if(ladder.length>=2)return {low:ladder[0],high:ladder[ladder.length-1]};
  var dr=tdraft[p];if(dr)return dr;
  return {low:ladder[0]||'',high:ladder[0]||''};
}
function endSelect(cls,p,val){
  var list=rankedOf(p),known=!val||list.indexOf(val)>=0;
  var opts='<option value=""'+(val?'':' selected')+'>not tiered</option>'+list.map(function(m){return '<option value="'+h(m)+'"'+(m===val?' selected':'')+'>'+h(m)+'</option>'}).join('');
  if(!known)opts+='<option value="'+h(val)+'" selected>&#9888; '+h(val)+' (cannot be ranked)</option>';
  return '<select class="'+cls+(known?'':' invalid')+'">'+opts+'</select>';
}
function betweenCell(p,ladder){
  if(ladder.length<2)return '<span class="tnone">'+(ladder.length?'one model: every step uses it':'this provider keeps each role\\'s own model')+'</span>';
  var inner=rangeOf(p,ladder[0],ladder[ladder.length-1]).slice(1,-1);
  if(!inner.length)return '<span class="tnone">no models between these two</span>';
  return inner.map(function(m){return '<label><input type="checkbox" class="tchip" value="'+h(m)+'"'+(ladder.indexOf(m)>=0?' checked':'')+'> '+h(m)+'</label>'}).join('');
}
function renderTiers(){
  var box=document.getElementById('tiers');if(!box)return;
  var t=tierView(),agents=Object.keys(state.agents),scoped=t.roles||agents;
  var head='<div class="tphead"><div></div><div>Low<small>weakest allowed</small></div><div>High<small>strongest allowed</small></div><div>In between<small>untick any to skip it</small></div></div>';
  var rows=defs.filter(function(d){return isReady(d.id)&&rankedOf(d.id).length}).map(function(d){
    var ladder=(t.providers||{})[d.id]||[],ends=endsOf(d.id,ladder);
    return '<div class="tprow" data-provider="'+h(d.id)+'"><div class="tprovname">'+h(d.name)+'<small>'+(d.tools?'tools':'advisory')+'</small></div>'+
      endSelect('tlow',d.id,ends.low)+endSelect('thigh',d.id,ends.high)+'<div class="tbetween">'+betweenCell(d.id,ladder)+'</div></div>';
  }).join('');
  var roles=agents.map(function(id){return '<label class="tchk"><input type="checkbox" data-role="'+h(id)+'"'+(scoped.indexOf(id)>=0?' checked':'')+'> '+h(id)+'</label>'}).join('');
  box.className='tiers'+(t.enabled?'':' off');
  box.innerHTML='<label class="tswitch"><input type="checkbox" id="tiers-on"'+(t.enabled?' checked':'')+'> Pick the model by task difficulty</label>'+
    '<p class="hint">Each step is rated from trivial to very hard before it runs: council steps by their job, free-form messages by their wording. A role then lands on the matching model between its provider\\'s Low and High, so an in-between task gets an in-between model, and a role on OpenAI only ever uses OpenAI\\'s range while a role on Claude can reach Opus. Leave a provider on "not tiered" to keep its roles on their own model. Only models whose names carry a version number can be ordered, so only those are offered. Quick, tool-free steps also skip loading MCP servers, so they answer faster.</p>'+
    '<div class="tgrid">'+head+rows+'</div><div class="tscope"><b>Applies to:</b>'+roles+'</div>';
}
function readTiers(){
  var box=document.getElementById('tiers');if(!box||!box.querySelector('.tgrid'))return;
  var on=document.getElementById('tiers-on').checked;
  if(!state.tiers&&!on)return; /* never created: do not send (and have the server validate) untouched defaults */
  var t=state.tiers||defaultTiers();t.enabled=on;t.providers=t.providers||{};
  box.querySelectorAll('.tprow').forEach(function(row){
    var p=row.dataset.provider,lo=row.querySelector('.tlow').value,hi=row.querySelector('.thigh').value;
    tdraft[p]={low:lo,high:hi};
    if(!lo&&!hi){delete t.providers[p];return}
    var both=Boolean(lo&&hi),one=lo||hi;lo=lo||one;hi=hi||one; /* a single end pins that one model */
    var span=rangeOf(p,lo,hi);
    if(both&&span.length)tdraft[p]={low:span[0],high:span[span.length-1]}; /* ends given backwards are put the right way round */
    if(!span.length){t.providers[p]=lo===hi?[lo]:[lo,hi];return}
    var first=span[0],last=span[span.length-1],prev=t.providers[p];
    var sameEnds=prev&&prev[0]===first&&prev[prev.length-1]===last; /* new ends: everything between is allowed again */
    var ticked=Array.from(row.querySelectorAll('.tchip:checked')).map(function(c){return c.value});
    var mid=span.slice(1,-1).filter(function(m){return !sameEnds||ticked.indexOf(m)>=0});
    t.providers[p]=span.length===1?[first]:[first].concat(mid,[last]);
  });
  var all=Object.keys(state.agents),picked=Array.from(box.querySelectorAll('input[data-role]:checked')).map(function(i){return i.dataset.role});
  if(picked.length===all.length)delete t.roles;else t.roles=picked;
  state.tiers=t;
}
function bindTiers(){var box=document.getElementById('tiers');if(!box)return;box.onchange=function(){dirty=true;readTiers();renderTiers();note()}}
`;
