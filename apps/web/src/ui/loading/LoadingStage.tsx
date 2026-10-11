import type { ReactNode } from 'react';
import { APP_VERSION, APP_VERSION_LABEL } from '../../lib/version';
import { LoadingBackdrop } from './LoadingBackdrop';
import './gameLoading.css';

/** The one loading composition (D-193): the bright wallpaper fills the screen
 *  and is the point; one slim strip (the child GameLoading) docks at the bottom
 *  above the safe area; the version label sits in the bottom-left corner
 *  outside the strip. Overlay's LoadingScreen and PhaserGame's scene-
 *  preparation cover both render it, so the handoff between them keeps the
 *  strip, its tip and the label exactly where they were (owner 2026-09-27:
 *  "flickering or dizzying on loading box"; teammate 2026-09-28: "minimize
 *  the opening kingdom bar and place it on the bottom of the screen"). */
export function LoadingStage({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <>
      <LoadingBackdrop />
      <div className="sk-loading-dock">
        {/* The same version the ABOUT pane and the native boot screen print (D-192: one product version). */}
        <p className="sk-loading-version" aria-label={`Version ${APP_VERSION}`}>{APP_VERSION_LABEL}</p>
        {children}
      </div>
    </>
  );
}
