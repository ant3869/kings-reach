// src/skill-cli.ts - manage the skill library.   node dist/skill-cli.js <command>
//
//   list                                   every skill with its state, check result and who gets it
//   show <name>                            frontmatter, provenance, scan findings
//   install <source> [--name N] [--text-only] [--license L] [--note "..."]
//                                          source = github:owner/repo/path@ref  OR  a local folder. Lands in QUARANTINE.
//   enable <name> [--inline] [--note "..."]  scan again, activate, record the approved content hash.
//                                          --inline: paste the whole skill into prompts for tool-less providers
//   disable <name>                         deactivate (kept on disk)
//   trust <name>                           re-approve an active skill after you read its changes
//   assign <agent|*> <name> [--required]   give a skill to an agent (use "*" for everyone)
//   unassign <agent|*> <name>
//   create <name> "<description>"          scaffold a draft in skillpack/proposed/ (then: install that folder)
//   doctor [--live]                        registry vs disk, per-agent resolution, tool availability; --live asks the SDK
//
// Installing never activates anything. Scripts inside a skill are never run by this tool.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { loadAgentConfigs } from './agent-config.js';
import { copySkillDir, fetchGithubSkill, parseGithubSpec } from './skill-install.js';
import { NAME_RE, hasErrors, hashSkillDir, parseFrontmatter, scanSkillDir, type Finding } from './skill-scan.js';
import { PLUGIN_NAME, PROPOSED_DIR, QUARANTINE_DIR, SKILLPACK_DIR, SKILLS_DIR, readRegistry, skillsFor, verifySkill, writeRegistry, type SkillEntry } from './skills.js';
import { probeResearch } from './research-probe.js';

const STAGING = join(PROJECT_ROOT, 'store', 'skill-staging');

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args: string[], name: string): boolean => args.includes(`--${name}`);
const positional = (args: string[]): string[] => args.filter((a, i) => !a.startsWith('--') && !(args[i - 1]?.startsWith('--') && !['text-only', 'required', 'live', 'inline'].includes(args[i - 1]!.slice(2))));

function show(findings: Finding[]): void {
  for (const f of findings) console.log(`  ${f.level === 'error' ? 'ERROR' : 'warn '} ${f.file}: ${f.message}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireSkill(name: string | undefined): string {
  const registry = readRegistry();
  if (!name || !registry.skills[name]) fail(`unknown skill "${name ?? ''}". Try: list`);
  return name;
}

async function install(args: string[]): Promise<void> {
  const [source] = positional(args);
  if (!source) fail('usage: install <github:owner/repo/path@ref | local-folder> [--name N] [--text-only] [--license L] [--note "..."]');
  mkdirSync(STAGING, { recursive: true });
  const staged = join(STAGING, `incoming-${Date.now()}`);
  mkdirSync(staged, { recursive: true });
  let entrySource: SkillEntry['source'];
  const gh = parseGithubSpec(source);
  if (gh) {
    const fetched = await fetchGithubSkill(gh, staged, has(args, 'text-only'));
    console.log(`fetched ${fetched.files} files from ${fetched.repo}@${fetched.ref.slice(0, 7)}${fetched.skipped.length ? ` (left behind: ${fetched.skipped.join(', ')})` : ''}`);
    entrySource = { type: 'github', repo: fetched.repo, ref: fetched.ref, path: fetched.path, license: flag(args, 'license') ?? fetched.license };
  } else if (existsSync(source)) {
    copySkillDir(resolve(source), staged);
    entrySource = { type: 'local', path: resolve(source), license: flag(args, 'license'), repo: flag(args, 'repo'), ref: flag(args, 'ref') };
  } else {
    fail(`"${source}" is neither a github: spec nor an existing folder`);
  }
  const meta = parseFrontmatter(existsSync(join(staged, 'SKILL.md')) ? readFileSync(join(staged, 'SKILL.md'), 'utf8') : '');
  const name = flag(args, 'name') ?? String(meta?.['name'] ?? '');
  if (!NAME_RE.test(name)) fail('could not determine a valid skill name (lowercase, digits, hyphens): pass --name');
  const registry = readRegistry();
  if (registry.skills[name]) fail(`"${name}" is already installed. disable it and remove skillpack/*/${name} first, or pick --name`);
  const findings = scanSkillDir(staged, name);
  show(findings);
  if (hasErrors(findings)) {
    console.error(`REFUSED: "${name}" failed the scan. Staged copy kept at ${staged} for inspection.`);
    process.exit(2);
  }
  const target = join(QUARANTINE_DIR, name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(QUARANTINE_DIR, { recursive: true });
  renameSync(staged, target);
  registry.skills[name] = { state: 'quarantined', sha256: hashSkillDir(target), source: entrySource, installedAt: new Date().toISOString(), note: flag(args, 'note') };
  writeRegistry(registry);
  console.log(`installed "${name}" into quarantine (not active). Read ${join('skillpack', 'quarantine', name, 'SKILL.md')}, then: enable ${name}`);
}

function enable(name: string, args: string[]): void {
  const registry = readRegistry();
  const entry = registry.skills[name]!;
  const note = flag(args, 'note');
  if (note) entry.note = [entry.note, note].filter(Boolean).join(' | ');
  if (has(args, 'inline')) entry.inline = true;
  const from = entry.state === 'quarantined' ? join(QUARANTINE_DIR, name) : join(SKILLS_DIR, name);
  const findings = scanSkillDir(from, name);
  show(findings);
  if (hasErrors(findings)) fail(`REFUSED: "${name}" fails the scan`);
  if (entry.state === 'quarantined') {
    mkdirSync(SKILLS_DIR, { recursive: true });
    renameSync(from, join(SKILLS_DIR, name));
  }
  entry.state = 'active';
  entry.sha256 = hashSkillDir(join(SKILLS_DIR, name));
  writeRegistry(registry);
  console.log(`"${name}" is active. Assign it to an agent to use it: assign <agent|*> ${name} [--required]`);
}

function assign(args: string[], remove: boolean): void {
  const [agent, name] = positional(args);
  if (!agent || !name) fail(`usage: ${remove ? 'unassign' : 'assign'} <agent|*> <skill> ${remove ? '' : '[--required]'}`);
  requireSkill(name);
  const registry = readRegistry();
  const slot = (registry.agents[agent] ??= { required: [], available: [] });
  slot.required = slot.required.filter((n) => n !== name);
  slot.available = slot.available.filter((n) => n !== name);
  if (!remove) (has(args, 'required') ? slot.required : slot.available).push(name);
  writeRegistry(registry);
  console.log(`${agent}: required=[${slot.required}] available=[${slot.available}]`);
}

function create(args: string[]): void {
  const [name, ...rest] = positional(args);
  const description = rest.join(' ').trim();
  if (!name || !NAME_RE.test(name) || !description) fail('usage: create <name> "<what it does and when to use it>"');
  const dir = join(PROPOSED_DIR, name);
  if (existsSync(dir)) fail(`${dir} already exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n## When to use\n\n## Steps\n\n1. \n\n## Done when\n\n- \n`, 'utf8');
  console.log(`draft written to ${dir}\nEdit it, then: install ${dir} --note "written by <who>"`);
}

function list(): void {
  const registry = readRegistry();
  const agents = loadAgentConfigs().map((a) => a.id);
  for (const [name, entry] of Object.entries(registry.skills)) {
    const verdict = entry.state === 'active' ? verifySkill(name, registry) : { ok: true };
    const users = agents.filter((a) => [...skillsFor(a, registry).required, ...skillsFor(a, registry).available].includes(name));
    const origin = entry.source.type === 'github' ? `${entry.source.repo}@${entry.source.ref?.slice(0, 7)}` : (entry.source.repo ? `${entry.source.repo}@${entry.source.ref?.slice(0, 7) ?? '?'} (adapted)` : 'local');
    console.log(`${name.padEnd(26)} ${entry.state.padEnd(11)} ${verdict.ok ? 'ok      ' : 'REJECTED'} ${origin.padEnd(40)} -> ${users.join(', ') || '(unassigned)'}${verdict.ok ? '' : `   [${verdict.reason}]`}`);
  }
}

async function doctor(live: boolean): Promise<void> {
  const registry = readRegistry();
  let problems = 0;
  const note = (ok: boolean, text: string): void => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) problems++; };
  for (const [name, entry] of Object.entries(registry.skills)) {
    const dir = join(entry.state === 'quarantined' ? QUARANTINE_DIR : SKILLS_DIR, name);
    if (entry.state === 'disabled') { note(true, `${name}: disabled`); continue; }
    if (entry.state === 'active') { const v = verifySkill(name, registry); note(v.ok, `${name}: active ${v.ok ? '' : `- ${v.reason}`}`); } else note(existsSync(dir), `${name}: quarantined`);
  }
  for (const key of Object.keys(registry.agents)) {
    if (key !== '*' && !loadAgentConfigs().some((a) => a.id === key)) note(false, `assignment for unknown agent "${key}"`);
    for (const name of [...registry.agents[key]!.required, ...registry.agents[key]!.available]) if (!registry.skills[name]) note(false, `${key} references unknown skill "${name}"`);
  }
  for (const agent of loadAgentConfigs()) {
    const r = skillsFor(agent.id, registry);
    note(r.rejected.length === 0, `${agent.id}: ${r.required.length} required, ${r.available.length} available${r.rejected.length ? `, rejected: ${r.rejected.map((x) => `${x.name} (${x.reason})`).join('; ')}` : ''}`);
  }
  const research = await probeResearch();
  note(research.ok, `research capability: ${research.summary}`);
  if (live) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { claudeSkillOptions } = await import('./skills.js');
    for (const agent of loadAgentConfigs()) {
      const expected = claudeSkillOptions(agent.id).skills ?? [];
      const q = query({ prompt: (async function* () { await new Promise(() => undefined); })(), options: { cwd: agent.cwd, settingSources: ['project', 'user'], permissionMode: 'bypassPermissions', ...claudeSkillOptions(agent.id) } as never });
      try {
        // getContextUsage() reports what is really in the model's prompt (supportedCommands() is only raw discovery).
        await Promise.race([q.supportedCommands(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), 45_000))]);
        const usage = await q.getContextUsage();
        const loaded = (usage.skills?.skillFrontmatter ?? []).map((s) => `${s.name}|${s.source}`);
        const want = expected.map((e) => e.split(':')[1] ?? e);
        const missing = want.filter((n) => !loaded.includes(`${n}|plugin`));
        const extra = loaded.filter((l) => !want.some((n) => l === `${n}|plugin`));
        note(missing.length === 0 && extra.length === 0,
          `${agent.id}: prompt holds ${want.length - missing.length}/${want.length} assigned skills (~${usage.skills?.tokens ?? '?'} tokens)${missing.length ? `, MISSING ${missing.join(', ')}` : ''}${extra.length ? `, UNEXPECTED ${extra.join(', ')}` : ''}`);
      } catch (err) {
        note(false, `${agent.id}: live check failed: ${String(err)}`);
      } finally {
        q.close();
      }
    }
  }
  console.log(problems ? `\n${problems} problem(s)` : `\nall good (${PLUGIN_NAME} plugin at ${SKILLPACK_DIR})`);
  process.exitCode = problems ? 1 : 0; // not process.exit(): on Windows that races open sockets and trips a libuv assertion
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'list': return list();
    case 'show': {
      const name = requireSkill(args[0]);
      const entry = readRegistry().skills[name]!;
      const dir = join(entry.state === 'quarantined' ? QUARANTINE_DIR : SKILLS_DIR, name);
      console.log(JSON.stringify({ name, ...entry, frontmatter: parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8')) }, null, 2));
      return show(scanSkillDir(dir, name));
    }
    case 'install': return install(args);
    case 'enable': return enable(requireSkill(args[0]), args);
    case 'disable': { const n = requireSkill(args[0]); const r = readRegistry(); r.skills[n]!.state = 'disabled'; writeRegistry(r); return console.log(`"${n}" disabled`); }
    case 'trust': {
      const n = requireSkill(args[0]);
      const r = readRegistry();
      const findings = scanSkillDir(join(SKILLS_DIR, n), n);
      show(findings);
      if (hasErrors(findings)) fail('REFUSED: scan errors');
      r.skills[n]!.sha256 = hashSkillDir(join(SKILLS_DIR, n));
      writeRegistry(r);
      return console.log(`"${n}" re-approved at ${r.skills[n]!.sha256.slice(0, 12)}`);
    }
    case 'assign': return assign(args, false);
    case 'unassign': return assign(args, true);
    case 'create': return create(args);
    case 'doctor': return doctor(has(args, 'live'));
    default: fail('commands: list | show | install | enable | disable | trust | assign | unassign | create | doctor [--live]');
  }
}

main().catch((err) => fail(String(err instanceof Error ? err.message : err)));
