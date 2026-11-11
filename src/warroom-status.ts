// src/warroom-status.ts - the few live numbers the War Room "Council Status" panel shows.
// Every field has a real source or is null; the page renders null as "unavailable", never a made-up number.

import { activePlan } from './history.js';
import { STARTED_AT, count } from './health.js';

export interface WarRoomStatus {
  uptimeSec: number;
  memories: number | null;
  plan: { run: string; steps: number } | null;
}

export function warRoomStatus(): WarRoomStatus {
  const plan = activePlan();
  return {
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    memories: count('memories'),
    plan: plan ? { run: plan.run, steps: plan.steps } : null,
  };
}
