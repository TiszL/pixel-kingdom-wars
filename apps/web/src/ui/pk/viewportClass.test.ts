import { describe, expect, it } from 'vitest';
import { classifyPkViewport, stampPkViewport } from './viewportClass';

describe('one dimension owner for attribute-only kit CSS (W10)', () => {
  it.each([
    [412, 915, 'phone-portrait', false], [844, 390, 'phone-landscape', false],
    [768, 1024, 'tablet-portrait', false], [1024, 768, 'tablet-landscape', false],
    [1440, 900, 'desktop', false], [1920, 1080, 'desktop', false],
    [320, 640, 'phone-portrait', false], [915, 311, 'phone-landscape', true],
    [844, 359, 'phone-landscape', true], [844, 360, 'phone-landscape', false],
    [1200, 480, 'phone-landscape', false], [1200, 481, 'desktop', false],
    [767, 1024, 'phone-portrait', false], [1199, 900, 'tablet-landscape', false],
  ])('classifies %s × %s before CSS is read', (w, h, vp, short) => {
    expect(classifyPkViewport(w as number, h as number)).toEqual({ vp, short });
  });
  it('clears the short-height attribute when rotating back to portrait', () => {
    const root = { dataset: {} as Record<string, string> };
    stampPkViewport(root, 915, 311);
    expect(root.dataset).toEqual({ pkVp: 'phone-landscape', pkVpHeight: 'short' });
    stampPkViewport(root, 412, 915);
    expect(root.dataset).toEqual({ pkVp: 'phone-portrait' });
  });
  it('does not rewrite unchanged attributes on every measured frame', () => {
    let writes = 0;
    const dataset = new Proxy({ pkVp: 'phone-portrait' } as Record<string, string>, {
      set(target, key, value) { writes++; target[key as string] = value; return true; },
      deleteProperty(target, key) { writes++; delete target[key as string]; return true; },
    });
    stampPkViewport({ dataset }, 412, 915);
    expect(writes).toBe(0);
  });
});
