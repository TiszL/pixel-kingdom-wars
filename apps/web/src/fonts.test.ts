/**
 * ONE FACE EVERYWHERE (owner 2026-09-17). The game's UI is VT323 for headings
 * and actions, and it was a system sans for body copy — which the owner read,
 * from production, as "font still not loaded". Body copy is VT323 now, and
 * this test is what stops a system stack creeping back in through a new
 * screen's stylesheet or an inline style. index.html's pre-React boot is the
 * one deliberate exception: it paints before the font file arrives.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('.', import.meta.url).pathname;
const SANS = /system-ui|-apple-system|BlinkMacSystemFont|Segoe UI|sans-serif|font-sans/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('the pixel face is the only face', () => {
  it('resolves --sk-font-body to VT323', () => {
    const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
    expect(css).toMatch(/--sk-font-body:\s*'VT323', monospace;/);
    expect(css).toMatch(/--sk-font-game:\s*'VT323', monospace;/);
  });

  it('names no system sans stack anywhere in the overlay source', () => {
    const offenders = walk(SRC)
      .filter((path) => SANS.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(SRC.length));
    expect(offenders).toEqual([]);
  });
});
