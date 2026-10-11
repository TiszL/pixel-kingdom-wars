import { Component, type ReactNode } from 'react';
import { captureError } from '../lib/analytics';
import { useApp } from '../state/store';

/** A rejected lazy Phaser import must not unmount auth, the overlay, or the
 * update prompt. React caches that rejection, so retry by reloading the page;
 * never clear the verified pack, session, or durable raid pointer. */
export class GameLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    console.error('[game] canvas load failed; reload available:', error);
    // Relayed through the denylist: a stale-bundle chunk failure (the common
    // case after a deploy) is dropped there; anything else reaches Sentry.
    captureError('error', {
      message: error.message, name: error.name, source: 'react-boundary',
      boundary: 'game', screen: useApp.getState().screen,
    });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <div className="interactive" role="alert" style={{
      position: 'absolute', inset: 0, zIndex: 5000, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24,
      textAlign: 'center', background: 'rgba(16,14,20,.96)', color: '#e9e2d0',
    }}>
      <div style={{ fontSize: 22, letterSpacing: '2px' }}>Couldn’t load your kingdom</div>
      <div style={{ maxWidth: 360, fontSize: 15, lineHeight: 1.5 }}>
        Please try again.
      </div>
      <button onClick={() => window.location.reload()} style={{
        padding: '10px 22px', background: '#caa04a', border: '2px solid #1b1720',
        color: '#1b1720', fontSize: 16, cursor: 'pointer',
      }}>TRY AGAIN</button>
    </div>;
  }
}
