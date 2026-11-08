// tests/run-control.test.mjs - the registry that lets every surface stop a run, and the process-tree kill behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { activeRuns, cancelRuns, isCancelled, killTree, RunCancelled, spawnClaudeCli, startRun, throwIfCancelled } from '../dist/run-control.js';
import { clearQueue, enqueue } from '../dist/message-queue.js';

test('registry: runs list oldest first without exposing their controllers, and finish() removes them', () => {
  const a = startRun({ agentId: 'main', chatId: '1' });
  const b = startRun({ agentId: 'ops', stage: 'plan' });
  const list = activeRuns();
  assert.deepEqual(list.map((r) => r.agentId), ['main', 'ops']);
  assert.ok(list.every((r) => !('controller' in r) && typeof r.startedAt === 'number' && r.id.length === 8));
  a.finish();
  assert.deepEqual(activeRuns().map((r) => r.agentId), ['ops']);
  b.finish();
  assert.deepEqual(activeRuns(), []);
});

test('cancelRuns matches by id, by chat, or all; with no criteria it cancels nothing', () => {
  const a = startRun({ agentId: 'main', chatId: 'x' });
  const b = startRun({ agentId: 'ops', chatId: 'y' });
  const c = startRun({ agentId: 'comms', chatId: 'x' });
  assert.equal(cancelRuns({}), 0);
  assert.equal(cancelRuns({ all: false }), 0);
  assert.equal(cancelRuns({ id: 'nope' }), 0);
  assert.equal([a, b, c].filter((r) => r.signal.aborted).length, 0);
  assert.equal(cancelRuns({ chatId: 'x' }), 2);
  assert.deepEqual([a, b, c].map((r) => r.signal.aborted), [true, false, true]);
  assert.equal(cancelRuns({ id: b.id }), 1);
  assert.equal(cancelRuns({ all: true }), 3, 'cancelled runs stay listed until their owner calls finish()');
  [a, b, c].forEach((r) => r.finish());
  assert.equal(cancelRuns({ all: true }), 0);
});

test('a parent signal cancels the run, an already-aborted parent cancels it at once, and finish() detaches the listener', () => {
  const parent = new AbortController();
  const run = startRun({ agentId: 'main' }, parent.signal);
  assert.equal(run.signal.aborted, false);
  parent.abort();
  assert.equal(run.signal.aborted, true);
  run.finish();
  const late = startRun({ agentId: 'main' }, parent.signal);
  assert.equal(late.signal.aborted, true);
  late.finish();
  const p2 = new AbortController();
  const detached = startRun({ agentId: 'main' }, p2.signal);
  detached.finish();
  p2.abort();
  assert.equal(detached.signal.aborted, false, 'a finished run no longer follows its parent');
});

test('RunCancelled is recognised by name as well as by class, and throwIfCancelled only throws once aborted', () => {
  assert.ok(isCancelled(new RunCancelled()));
  assert.ok(isCancelled(Object.assign(new Error('x'), { name: 'RunCancelled' })));
  assert.equal(isCancelled(new Error('x')), false);
  assert.equal(isCancelled(null), false);
  const ac = new AbortController();
  assert.doesNotThrow(() => throwIfCancelled(ac.signal));
  assert.doesNotThrow(() => throwIfCancelled(undefined));
  ac.abort();
  assert.throws(() => throwIfCancelled(ac.signal), RunCancelled);
});

test('clearQueue drops what is waiting behind the running message, and nothing else', async () => {
  let release;
  const ran = [];
  const first = enqueue('q1', () => new Promise((resolve) => { release = () => { ran.push('first'); resolve(); }; }));
  await enqueue('q1', async () => { ran.push('second'); });
  await enqueue('q1', async () => { ran.push('third'); });
  assert.equal(clearQueue('q1'), 2);
  assert.equal(clearQueue('q1'), 0);
  assert.equal(clearQueue('never-used'), 0);
  release();
  await first;
  assert.deepEqual(ran, ['first'], 'the running one finishes; the cleared ones never start');
  await enqueue('q1', async () => { ran.push('later'); }); // the queue still works afterwards
  assert.deepEqual(ran, ['first', 'later']);
});

const pingsMarked = (mark) => Number(execFileSync('powershell', ['-NoProfile', '-Command',
  `(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -match '${mark}' } | Measure-Object).Count`], { encoding: 'utf8', windowsHide: true }).trim());

test('killTree takes down the grandchild that child.kill() would leave running (Windows)', { skip: process.platform !== 'win32' }, async () => {
  // cmd.exe -> ping.exe: the same shape as `cmd /c codex.cmd` -> the real worker.
  const child = spawn('cmd.exe', ['/c', 'ping -n 98 127.0.0.1 >NUL'], { windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40 && pingsMarked('-n 98 ') === 0; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(pingsMarked('-n 98 '), 1, 'grandchild is running');
    const exited = new Promise((resolve) => child.on('exit', resolve));
    killTree(child.pid);
    await exited;
    for (let i = 0; i < 20 && pingsMarked('-n 98 ') !== 0; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(pingsMarked('-n 98 '), 0, 'the whole tree is gone');
  } finally {
    child.kill();
  }
});

test('killTree ignores a missing pid', () => {
  assert.doesNotThrow(() => killTree(undefined));
  assert.doesNotThrow(() => killTree(0));
});

test('spawnClaudeCli: aborting ends the CLI AND the command it started; finishing normally leaves the signal alone (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const ac = new AbortController();
  const child = spawnClaudeCli({ command: 'cmd.exe', args: ['/c', 'ping -n 96 127.0.0.1 >NUL'], env: process.env, signal: ac.signal });
  assert.ok(child.stdin && child.stdout, 'the SDK needs stdin and stdout pipes');
  try {
    for (let i = 0; i < 40 && pingsMarked('-n 96 ') === 0; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(pingsMarked('-n 96 '), 1, 'the command the CLI started is running');
    const exited = new Promise((resolve) => child.on('exit', resolve));
    ac.abort();
    await exited;
    for (let i = 0; i < 20 && pingsMarked('-n 96 ') !== 0; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(pingsMarked('-n 96 '), 0, 'abort must not orphan the CLI\'s own child processes');
  } finally {
    child.kill();
  }
  // An already-aborted signal never leaves a running process behind either.
  const gone = new AbortController(); gone.abort();
  const dead = spawnClaudeCli({ command: 'cmd.exe', args: ['/c', 'ping -n 95 127.0.0.1 >NUL'], env: process.env, signal: gone.signal });
  const deadExit = new Promise((resolve) => dead.on('exit', resolve));
  await deadExit;
  assert.equal(pingsMarked('-n 95 '), 0);
});

test('spawnClaudeCli: a plain kill() (what the SDK issues on shutdown) also takes the CLI\'s children with it (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const child = spawnClaudeCli({ command: 'cmd.exe', args: ['/c', 'ping -n 94 127.0.0.1 >NUL'], env: process.env, signal: new AbortController().signal });
  try {
    for (let i = 0; i < 40 && pingsMarked('-n 94 ') === 0; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(pingsMarked('-n 94 '), 1);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    for (let i = 0; i < 20 && pingsMarked('-n 94 ') !== 0; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(pingsMarked('-n 94 '), 0, 'kill() alone used to orphan the grandchild: the parent died before taskkill could walk the tree');
  } finally {
    child.kill();
  }
});
