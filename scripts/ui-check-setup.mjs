// scripts/ui-check-setup.mjs - the dashboard's "Getting started" card, rendered in real Chrome. /api/setup and the re-check are
// stubbed on the page: the card depends on your machine's real state, and the re-check spends a few tokens, so neither may be real here.

const item = (id, title, state, required = true, fix = null, detail = 'detail') => ({ id, title, state, required, detail, fix });
const reply = (v) => JSON.stringify(JSON.stringify(v)); // a JS string literal holding the JSON

const stub = (checklist, checkReply) => `(function () {
  var real = window.fetch.bind(window); window.__checks = [];
  var json = function (body) { return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })); };
  window.fetch = function (u, o) { var s = String(u);
    if (s.indexOf('/api/setup') >= 0) return json(${reply(checklist)});
    if (s.indexOf('/api/providers/') >= 0 && s.indexOf('/check') >= 0) { window.__checks.push({ url: s, method: (o && o.method) || 'GET' }); return json(${reply(checkReply)}); }
    return real(u, o); };
})();`;

const PROBLEM = { id: 'openai', detail: 'OPENAI_API_KEY configured; quota / credits exhausted (<img src=x onerror=window.__xss=1>)', fix: 'Out of credit. Add credit, then press Re-check.', recheck: true };
const NOT_READY = { ready: false, problems: [PROBLEM], items: [
  item('env', 'Settings file exists', 'ok'),
  item('claude', 'Signed in to Claude', 'ok'),
  item('fallback', 'A fallback model is ready', 'todo', true, 'Set OPENAI_API_KEY in .env.'),
  item('firstrun', 'Ran your first council', 'todo', true, 'Open the War Room and convene the council.'),
  item('telegram', 'Chat from your phone (Telegram)', 'todo', false, 'Set TELEGRAM_BOT_TOKEN.'),
] };

export async function setupChecks({ open, js, check, sleep }) {
  const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || null`);

  await open('/', { pre: stub(NOT_READY, { ok: false, detail: 'quota / credits exhausted' }) });
  check('the card is shown when setup is incomplete', (await js(`document.getElementById('setup').hidden`)) === false);
  check('it says how far along you are', /Getting started/.test(await text('#setup-title')) && /2 of 4 done/.test(await text('#setup .sectionhead span')), await text('#setup .sectionhead span'));
  const steps = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#setup .steps li')].map((li) => [li.dataset.id, li.querySelector('.stepstate').textContent]))`));
  check('every step carries a word, not just a colour (Done / To do / Optional)',
    JSON.stringify(steps) === JSON.stringify([['env', 'Done'], ['claude', 'Done'], ['fallback', 'To do'], ['firstrun', 'To do'], ['telegram', 'Optional']]), JSON.stringify(steps));
  check('an undone step says what to do', /Set OPENAI_API_KEY in \.env\./.test(await text('#setup .steps li[data-id=fallback] .fix')));
  check('a finished step has no instructions', (await js(`document.querySelector('#setup .steps li[data-id=env] .fix')`)) === null);
  check('a provider problem is listed with its fix', /Out of credit/.test(await text('#setup .problems li[data-id=openai] .fix')));
  check('error text from a provider is shown as text, never parsed as HTML', (await js(`document.querySelectorAll('#setup img').length`)) === 0 && (await js('window.__xss')) === undefined);
  check('the re-check button says it spends money', /paid call/.test(await text('#setup .problems button')) && /1\u00a2/.test(await text('#setup .problems button')));
  check('nothing is spent until you press it', (await js('window.__checks.length')) === 0);

  await js(`document.querySelector('#setup .problems button').click()`);
  await sleep(500);
  const sent = JSON.parse(await js('JSON.stringify(window.__checks)'));
  check('Re-check sends one POST for that provider', sent.length === 1 && sent[0].method === 'POST' && /\/api\/providers\/openai\/check$/.test(sent[0].url), JSON.stringify(sent));
  check('a failed re-check shows the reason where you are looking, and the button works again',
    /quota \/ credits exhausted/.test(await text('#setup .problems [role=status]')) && (await js(`document.querySelector('#setup .problems button').disabled`)) === false);

  await open('/', { pre: stub({ ready: true, problems: [], items: [item('env', 'Settings file exists', 'ok')] }, {}) });
  check('the card is hidden when everything is fine', (await js(`document.getElementById('setup').hidden`)) === true && (await js(`document.getElementById('setup').childElementCount`)) === 0);

  await open('/', { pre: stub({ ready: true, problems: [PROBLEM], items: [item('env', 'Settings file exists', 'ok')] }, {}) });
  check('set up but one route failing: titled "Needs attention", no step list', /Needs attention/.test(await text('#setup-title')) && (await js(`document.querySelector('#setup .steps')`)) === null);
}
