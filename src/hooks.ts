/** Pre/post message hooks for extensibility. */

export type HookPhase = 'pre_message' | 'post_message';

export interface HookContext {
  chatId: string;
  agentId?: string;
  message: string;
  response?: string | null;
  blocked?: boolean;
  blockReason?: string;
}

export interface Hook {
  phase: HookPhase;
  name: string;
  handler: (ctx: HookContext) => Promise<void>;
}

const hooks: Hook[] = [];

export function registerHook(hook: Hook): void {
  hooks.push(hook);
}

export function clearHooks(): void {
  hooks.length = 0;
}

export function listHooks(): ReadonlyArray<Pick<Hook, 'phase' | 'name'>> {
  return hooks.map((h) => ({ phase: h.phase, name: h.name }));
}

export async function runHooks(phase: HookPhase, ctx: HookContext): Promise<void> {
  for (const hook of hooks) {
    if (hook.phase !== phase) continue;
    await hook.handler(ctx);
  }
}
