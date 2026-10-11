import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = '__PKW_BUILD_SHA__';
const BACKDROPS = ['portrait', 'landscape'];

/** Fail the build if Vite leaves any static loading-art URL on an unstamped
 * generation. Both orientations appear twice: preload plus picture source/img.
 * First paint must fetch the versioned loading wallpaper (owner 2026-09-24),
 * not the darker title backdrop. */
export function verifyVersionedHtml(html, buildSha) {
  if (typeof buildSha !== 'string' || buildSha.length === 0) {
    throw new Error('GIT_SHA must identify the web build');
  }
  if (html.includes(PLACEHOLDER)) {
    throw new Error(`built index.html still contains ${PLACEHOLDER}`);
  }

  const version = encodeURIComponent(buildSha);
  for (const orientation of BACKDROPS) {
    const url = `/brand/brand_loading_bg_${orientation}.png?v=${version}`;
    const occurrences = html.split(url).length - 1;
    if (occurrences !== 2) {
      throw new Error(`built index.html must contain exactly two ${orientation} backdrop URLs for ${buildSha}; found ${occurrences}`);
    }
  }
}

function main() {
  const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  verifyVersionedHtml(html, process.env.GIT_SHA ?? 'dev');
  console.log('Built loading backdrop URLs: versioned');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
