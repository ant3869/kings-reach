// public/card-director.js - decides WHICH card art each councillor shows. Pure logic (no DOM) so node can test it.
// Pools, weights and timings come from card-states/manifest.json (built by scripts/build_card_manifest.py).
// Without a manifest (404, offline) it falls back to the original four-state art, so the page never breaks.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardDirector = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const BASE = '/warroom/card-states/';
  const LEGACY = ['idle', 'thinking', 'speaking', 'building'];
  // Poses the legacy art does not have borrow the nearest legacy look.
  const NEAREST = { researching: 'thinking', confused: 'thinking', offense: 'speaking', defense: 'idle', defeated: 'idle' };

  const legacyUrl = (state, id) => BASE + 'individual/' + (LEGACY.includes(state) ? state : NEAREST[state] || 'idle') + '-' + id + '.png';

  /** Which state a seat should show. Speaking beats building beats a live one-shot pose beats thinking/idle. */
  function resolve(activity, now, stage) {
    if (!activity) return 'idle';
    if (activity.speaking) return 'speaking';
    if (activity.building) return 'building';
    if (activity.pose && activity.pose.until > now) return activity.pose.state;
    if (activity.thinking) return stage === 'investigate' ? 'researching' : 'thinking';
    return 'idle';
  }

  /** Weighted choice that avoids repeating `avoid` when there is any alternative. */
  function weightedPick(entries, avoid, rng) {
    const options = entries.length > 1 ? entries.filter((e) => e.src !== avoid) : entries;
    const total = options.reduce((sum, e) => sum + e.weight, 0);
    let roll = rng() * total;
    for (const e of options) { roll -= e.weight; if (roll < 0) return e; }
    return options[options.length - 1];
  }

  function create(manifest, opts) {
    const rng = (opts && opts.rng) || Math.random;
    const pools = (manifest && manifest.pools) || {};
    const last = {}; // seat id -> src it showed most recently

    function entries(state, id) {
      return (pools[state] || []).map((p) => ({ src: BASE + p[0].replace('{role}', id), weight: p[1] }));
    }
    function has(state) { return (pools[state] || []).length > 0; }

    /** URL of the art to show for this seat in this state. */
    function pick(state, id) {
      const list = entries(state, id);
      if (!list.length) return legacyUrl(state, id);
      const chosen = weightedPick(list, last[id], rng);
      last[id] = chosen.src;
      return chosen.src;
    }

    /** ms until this seat should swap to a different variant of the same state (null = hold). */
    function rotateDelayMs(state) {
      const range = manifest && manifest.rotateSeconds && manifest.rotateSeconds[state];
      if (!range || !has(state)) return null;
      return Math.round((range[0] + rng() * (range[1] - range[0])) * 1000);
    }

    function poseMs(state) { return (manifest && manifest.poseMs && manifest.poseMs[state]) || 7000; }

    return { pick, rotateDelayMs, poseMs, has, legacyUrl };
  }

  /** Fetch the manifest; any failure yields a director that uses the legacy art. */
  async function load(fetchFn) {
    try {
      const res = await (fetchFn || fetch)(BASE + 'manifest.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return create(await res.json());
    } catch (err) {
      return create(null);
    }
  }

  return { create, load, resolve, weightedPick, legacyUrl };
});
