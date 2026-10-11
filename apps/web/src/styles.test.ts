import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('canvas touch ownership', () => {
  it('prevents browser gestures from stealing Phaser pan and pinch input', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/canvas\s*\{[^}]*touch-action:\s*none;/s);
  });
});
