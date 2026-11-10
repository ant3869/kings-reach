// src/warroom-busy.ts - ask the War Room whether it is running anything, before something stops it.
//
// A council or Build now survives its browser tab, so "nobody is looking" no longer means "nothing is running". The War Room
// answers `GET /busy` with the number of tasks it is running across every tab, including tabs that have left. That is plain
// HTTP, so asking never takes over a run that is waiting for its page to come back.
//
// Servers older than v23 have no /busy. For those only, fall back to the websocket `ping`, which reports the same number
// (`busy`, server v22). A websocket connection DOES take over a detached run, so this fallback exists only for the one
// restart that moves the War Room onto v23, and it is never used on a poll: only when a stop was actually requested.
//
// `null` means "could not find out". The caller decides what that means; stopping must not hang on a wedged server.

import { WARROOM_PORT } from './config.js';

export const PROBE_TIMEOUT_MS = 1500;

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

async function viaHttp(port: number, fetchImpl: typeof fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/busy`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return count(((await res.json()) as { busy?: unknown }).busy);
  } catch {
    return null;
  }
}

function viaPing(port: number, WS: typeof WebSocket): Promise<number | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    const finish = (n: number | null): void => {
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
      resolve(n);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    try {
      ws = new WS(`ws://127.0.0.1:${port}`);
    } catch {
      finish(null);
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify({ type: 'ping' }));
    ws.onerror = () => finish(null);
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return;
      try {
        const m = JSON.parse(e.data) as { pong?: unknown; busy?: unknown };
        if (m.pong) finish(count(m.busy));
      } catch {
        /* not JSON: keep waiting for the pong */
      }
    };
  });
}

/** Tasks the War Room is running right now, or null if it could not be asked. */
export async function warroomBusy(
  port: number = WARROOM_PORT,
  fetchImpl: typeof fetch = fetch,
  WS: typeof WebSocket = globalThis.WebSocket,
): Promise<number | null> {
  return (await viaHttp(port, fetchImpl)) ?? (await viaPing(port, WS));
}
