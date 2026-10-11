import { versionedPublicAsset } from '../../lib/version';
import { BrandImage } from '../BrandImage';
import { usePortrait } from '../layout';

/** Bright loading key art (owner 2026-09-24: the loading screen was too dark). */
export const LOADING_BG_PORTRAIT = versionedPublicAsset('/brand/brand_loading_bg_portrait.png');
export const LOADING_BG_LANDSCAPE = versionedPublicAsset('/brand/brand_loading_bg_landscape.png');

/** The one loading wallpaper. Overlay's LoadingScreen and the base/battle
 *  opening shell in PhaserGame both render it, so handing off between them
 *  keeps the same bright picture instead of dropping to a flat dark fill. */
export function LoadingBackdrop(): React.JSX.Element {
  const port = usePortrait();
  return (
    <BrandImage
      src={port ? LOADING_BG_PORTRAIT : LOADING_BG_LANDSCAPE}
      alt=""
      loading="eager"
      decoding="sync"
      fetchPriority="high"
      style={{
        // Fixed, like the title BrandBg: it paints behind the native-toolbar
        // clearance and escapes the shell's scroll box.
        position: 'fixed', inset: 0, width: '100%', height: 'var(--game-viewport-frame-height, 100dvh)',
        objectFit: 'cover', imageRendering: 'pixelated', filter: 'brightness(.9)',
      }}
    />
  );
}
