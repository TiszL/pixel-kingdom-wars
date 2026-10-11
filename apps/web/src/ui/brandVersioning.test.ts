import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const overlay = readFileSync(new URL('./Overlay.tsx', import.meta.url), 'utf8');
const icons = readFileSync(new URL('./icons.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const menu = readFileSync(new URL('./screens/menu.tsx', import.meta.url), 'utf8');
const forgeCss = readFileSync(new URL('./screens/forge.css', import.meta.url), 'utf8');

describe('mutable public brand assets are atomic with the running build', () => {
  it('versions loading, title, login and generated portrait URLs', () => {
    const brandLiterals = [...overlay.matchAll(/['"](\/brand\/[^'"]+)['"]/g)]
      .map((match) => match[1]!);
    expect(brandLiterals.length).toBeGreaterThan(0);
    for (const literal of brandLiterals) {
      expect(overlay).toContain(`versionedPublicAsset('${literal}')`);
    }
    expect(app).toContain("logo: versionedPublicAsset('/brand/brand_logo_main.png')");
    expect(icons).toContain('versionedPublicAsset(`/brand/ware/${name}.png`)');
    expect(overlay).not.toContain('brand_emblem_pulse_f1');
    expect(overlay).toContain('width={422} height={294}');
    expect(icons).toContain("'!../../../../art/source/assets-v3/brand_*.svg'");
    expect(icons).toContain("'!../../../../art/source/assets-v2/brand_*.svg'");
  });

  it('versions the generated Forge scene in React instead of an old cache-first CSS URL', () => {
    expect(menu).toContain("versionedPublicAsset('/brand/ui_forgescene.png')");
    expect(forgeCss).not.toMatch(/url\(['"]?\/brand\//);
  });
});
