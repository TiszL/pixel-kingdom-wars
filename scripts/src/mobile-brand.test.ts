import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync(new URL('../../mobile/twa.config.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const rootPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const buildScript = readFileSync(new URL('../../mobile/build-apk.sh', import.meta.url), 'utf8');
const webManifest = JSON.parse(readFileSync(new URL('../../apps/web/public/manifest.webmanifest', import.meta.url), 'utf8')) as {
  icons: Array<{ src: string; sizes: string; purpose: string }>;
};
const html = readFileSync(new URL('../../apps/web/index.html', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../../apps/web/public/sw.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8');
const gameFont = readFileSync(new URL('../../apps/web/src/assets/fonts/VT323-latin-v18.woff2', import.meta.url));
const gameFontLicense = readFileSync(new URL('../../apps/web/src/assets/fonts/OFL.txt', import.meta.url), 'utf8');

describe('wave-2 Android/PWA identity contract', () => {
  it('preserves the published Android identity while enabling the Solana Mobile pack gate', () => {
    expect(config).toMatchObject({
      domain: 'play.pixelkingdomwars.com',
      applicationId: 'gg.pixelkingdomwars.twa',
      // 'default' lets the sensor rotate; the IN-GAME landscape setting locks
      // via the Screen Orientation API (owner 2026-08-16). Locking here would
      // make the setting a lie.
      orientation: 'default',
      // FULLSCREEN, not standalone (owner 2026-08-16: "game should feel like
      // real game… it should open up full screen") — hides the status bar in
      // the shell. Requires the Digital Asset Links check to pass or Chrome
      // shows its browser chrome regardless.
      display: 'fullscreen',
      // Ships the delegation so future upgrade-finished pushes need no new APK.
      enableNotifications: true,
      startUrl: '/?client=solana-mobile',
      iconUrl: '/icons/icon-512.png',
      maskableIconUrl: '/icons/icon-512.png',
      // ONE identity across the three version writers (root package.json,
      // apps/web/package.json, twa.config.json), not a frozen literal: `pnpm
      // apk:release` bumps all three together (D-101), and a literal here would
      // fail every legitimate cut while never catching real drift.
      appVersionName: rootPackage.version,
      language: 'en-US',
      signingKey: { path: './keystore/pkw-release.keystore', alias: 'pkw' },
    });
    expect(Number(config['appVersionCode'])).toBeGreaterThanOrEqual(11);
    // The generator must FORWARD the notification delegation, not hardcode it off.
    expect(buildScript).toContain('enableNotifications: c.enableNotifications === true,');
  });

  it('emits maskable only from the explicit owner safe-area contract and reapplies an English-only resource filter', () => {
    expect(buildScript).toContain('...(c.maskableIconUrl ? { maskableIconUrl:');
    expect(buildScript).not.toContain('(c.maskableIconUrl || c.iconUrl)');
    expect(buildScript).toContain('resourceConfigurations += ["${language}"]');
    expect(buildScript).toContain('PKW_LOCALE_FILTER_BEGIN');
    expect(buildScript).toContain('PKW_LOCALE_FILTER_END');
    expect(buildScript).toContain('BUBBLEWRAP_VERSION="1.25.0"');
    expect(buildScript).toContain('"$BUBBLEWRAP_BIN" update --skipVersionUpgrade');
    expect(buildScript).toContain('"$BUBBLEWRAP_BIN" build --directory "$OUT" --skipSigning');
    expect(buildScript).not.toContain('npx --yes');
    expect(buildScript).not.toContain('if [ -f "$OUT/build.gradle" ] || [ -d "$OUT/app" ]');
  });

  it('declares the supplied safe-area icon honestly and current favicon routes', () => {
    expect(webManifest.icons).toEqual([
      { src: '/icons/icon-192.png?v=c0137365', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png?v=c0137365', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png?v=c0137365', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
    expect(html).toContain('href="/manifest.webmanifest?v=c0137365"');
    expect(html).toContain('sizes="96x96" href="/icons/icon-96.png?v=c0137365"');
    expect(html).toContain('sizes="180x180" href="/icons/icon-180.png?v=c0137365"');
    // Keep one revision source for both shell URLs so the fixed-revision icon
    // exception in the service worker cannot drift from its own precache list.
    expect(serviceWorker).toContain("const SHELL_STATIC_REVISION = 'c0137365';");
    expect(serviceWorker).toContain('`/manifest.webmanifest?v=${SHELL_STATIC_REVISION}`');
    expect(serviceWorker).toContain('`/icons/icon-192.png?v=${SHELL_STATIC_REVISION}`');
    expect(html).not.toContain('brand_emblem_pulse');
  });

  it('self-hosts the exact VT323 v18 Latin face so ASCII game UI stays identical offline', () => {
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
    expect(styles).not.toContain('fonts.googleapis.com');
    expect(styles).not.toContain('fonts.gstatic.com');
    expect(styles).toContain("url('./assets/fonts/VT323-latin-v18.woff2')");
    expect(styles).toContain("font-family: 'VT323'");
    // A prior Vietnamese-only subset contained almost no printable ASCII and
    // silently forced generic monospace. Pin the known Google Latin v18 bytes.
    expect(gameFont).toHaveLength(7_192);
    expect(createHash('sha256').update(gameFont).digest('hex')).toBe(
      '043a60145af2ddbcd0a6452625cb0bfc4e18b222c76dcd1d4a0106715472faba',
    );
    expect(gameFontLicense).toContain('Copyright 2011, The VT323 Project Authors');
    expect(gameFontLicense).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});
