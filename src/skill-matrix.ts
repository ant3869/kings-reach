// src/skill-matrix.ts - which skills does each role get, and can they actually load? Pure: registry + roles + a verifier in, a matrix out (no I/O).
// Read-only by contract (see skills-routes.ts). It reports CONFIGURATION and the integrity check only. It cannot say whether a skill was used or helped:
// nothing records skill use (the skill_health table exists but no code writes to it), and a test keeps this note honest.

import type { Registry, SkillEntry, Verdict } from './skills.js';

export type CellStatus = 'required' | 'available' | 'none';
/** Where the assignment comes from: the "*" entry that applies to every role, the role's own entry, or both. */
export type CellVia = 'all roles' | 'this role' | 'both' | null;

export interface MatrixCell { status: CellStatus; via: CellVia; usable: boolean; blocked?: string }
export interface MatrixRole { id: string; name: string; active: boolean; required: number; available: number; blocked: number }
export interface MatrixSkill {
  name: string;
  state: SkillEntry['state'] | 'missing';
  source: string;
  installedAt: string | null;
  inline: boolean;
  note: string | null;
  verdict: Verdict;
  /** Roles (not counting "*") that get it, required or available. */
  assignedTo: number;
  cells: Record<string, MatrixCell>;
}
export interface MatrixProblem { level: 'warning' | 'info'; kind: 'unknown-skill' | 'unknown-role' | 'blocked-required' | 'blocked-assigned' | 'unassigned'; text: string }
export interface SkillMatrix { roles: MatrixRole[]; skills: MatrixSkill[]; problems: MatrixProblem[]; limits: string[] }

export interface RoleInfo { id: string; name?: string; active?: boolean }

export const MATRIX_LIMITS = [
  'This shows what is configured and whether each skill passes its integrity check. It does not show whether a skill was ever used or whether it helped: nothing records skill use.',
  'A skill that fails its check (wrong state, changed since approval, missing, or a scan error) is silently left out of runs, even a required one. That is what "blocked" means here.',
];

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const sourceOf = (s: SkillEntry['source'] | undefined): string => {
  if (!s) return 'unknown';
  if (s.type === 'github') return `github ${s.repo ?? '?'}${s.ref ? `@${s.ref.slice(0, 7)}` : ''}`;
  return s.type;
};

export function buildSkillMatrix(registry: Registry, roleInfos: RoleInfo[], verify: (name: string) => Verdict): SkillMatrix {
  const roleIds = roleInfos.map((r) => r.id);
  const problems: MatrixProblem[] = [];
  const entry = (key: string) => registry.agents[key];
  const scope = (key: string, kind: 'required' | 'available'): Set<string> => new Set(names(entry(key)?.[kind]));
  const wildReq = scope('*', 'required'), wildAvail = scope('*', 'available');

  // Every skill that is registered OR merely named by an assignment, so a typo shows up as a "missing" row rather than disappearing.
  const everyName = new Set<string>(Object.keys(registry.skills));
  for (const key of Object.keys(registry.agents)) for (const kind of ['required', 'available'] as const) for (const n of scope(key, kind)) everyName.add(n);

  const skills: MatrixSkill[] = [...everyName].sort().map((name) => {
    const reg = registry.skills[name];
    const verdict: Verdict = reg ? verify(name) : { ok: false, reason: 'not in the registry' };
    const cells: Record<string, MatrixCell> = {};
    let assignedTo = 0;
    for (const id of roleIds) {
      const own = { req: scope(id, 'required').has(name), avail: scope(id, 'available').has(name) };
      const all = { req: wildReq.has(name), avail: wildAvail.has(name) };
      const required = own.req || all.req, available = own.avail || all.avail;
      const status: CellStatus = required ? 'required' : available ? 'available' : 'none';
      const fromOwn = status === 'required' ? own.req : own.avail, fromAll = status === 'required' ? all.req : all.avail;
      const via: CellVia = status === 'none' ? null : fromOwn && fromAll ? 'both' : fromAll ? 'all roles' : 'this role';
      if (status !== 'none') assignedTo++;
      cells[id] = { status, via, usable: status === 'none' ? true : verdict.ok, ...(status !== 'none' && !verdict.ok ? { blocked: verdict.reason ?? 'rejected' } : {}) };
    }
    return { name, state: reg?.state ?? 'missing', source: sourceOf(reg?.source), installedAt: reg?.installedAt ?? null, inline: Boolean(reg?.inline), note: reg?.note ?? null, verdict, assignedTo, cells };
  });

  for (const s of skills) {
    if (s.state === 'missing') problems.push({ level: 'warning', kind: 'unknown-skill', text: `"${s.name}" is assigned to a role but is not in the registry, so it can never load.` });
    const requiredBy = roleIds.filter((id) => s.cells[id]!.status === 'required');
    if (s.state !== 'missing' && !s.verdict.ok && requiredBy.length) {
      problems.push({ level: 'warning', kind: 'blocked-required', text: `"${s.name}" is required for ${requiredBy.join(', ')} but is blocked (${s.verdict.reason}), so those roles run without it.` });
    } else if (s.state !== 'missing' && !s.verdict.ok && s.assignedTo > 0) {
      problems.push({ level: 'warning', kind: 'blocked-assigned', text: `"${s.name}" is offered to ${s.assignedTo} role${s.assignedTo > 1 ? 's' : ''} but is blocked (${s.verdict.reason}).` });
    }
    if (s.state !== 'missing' && s.assignedTo === 0) {
      problems.push({ level: 'info', kind: 'unassigned', text: `"${s.name}" is in the registry (${s.state}) but no role gets it.` });
    }
  }
  for (const key of Object.keys(registry.agents)) {
    if (key !== '*' && !roleIds.includes(key)) problems.push({ level: 'warning', kind: 'unknown-role', text: `The registry assigns skills to "${key}", which is not a configured role (a typo, or a retired role).` });
  }

  const roles: MatrixRole[] = roleInfos.map((r) => {
    const mine = skills.filter((s) => s.cells[r.id]!.status !== 'none');
    return { id: r.id, name: r.name ?? r.id, active: r.active !== false,
      required: mine.filter((s) => s.cells[r.id]!.status === 'required').length, available: mine.filter((s) => s.cells[r.id]!.status === 'available').length,
      blocked: mine.filter((s) => !s.cells[r.id]!.usable).length };
  });
  return { roles, skills, problems, limits: [...MATRIX_LIMITS] };
}
