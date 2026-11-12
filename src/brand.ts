// src/brand.ts - the King's Reach crest: which files exist, how a page links its icons, and the route that serves them.
// The files are built from one source image by scripts/make-brand.py. Only names listed here are ever served (no path joins).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { PROJECT_ROOT } from './config.js';

const TYPES: Record<string, string> = { ico: 'image/x-icon', png: 'image/png', webp: 'image/webp' };
export const BRAND_FILES: readonly string[] = [
  'favicon.ico', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png', 'kr-crest-96.webp', 'kr-crest-256.webp', 'kr-crest-512.png',
];

/** Goes in every page's <head>: tab icon (the .ico holds 16-48 px), a sharp 32 px PNG, the iOS home-screen icon, and the browser bar colour. */
export const ICON_LINKS = `<link rel="icon" href="/brand/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<meta name="theme-color" content="#090b0e">`;

export function mountBrand(app: Hono): void {
  const serve = (name: string) => (c: import('hono').Context) => {
    c.header('Content-Type', TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(readFileSync(join(PROJECT_ROOT, 'public', 'brand', name)) as unknown as string);
  };
  for (const name of BRAND_FILES) app.get(`/brand/${name}`, serve(name));
  app.get('/favicon.ico', serve('favicon.ico')); // browsers ask for this by default, even on a page with no <link>
}
