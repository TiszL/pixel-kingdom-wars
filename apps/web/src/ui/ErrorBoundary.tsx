/**
 * Overlay error boundary. A render/runtime throw anywhere in the React overlay
 * used to unmount the entire app — which also tore down the sibling <PhaserGame>
 * canvas, leaving a pure black screen (RaidUI hooks-order incident, 2026-07-19).
 *
 * Wrapping only the overlay (NOT PhaserGame) means a UI crash now shows a
 * recoverable panel while the game canvas stays alive underneath. The reset
 * routes back to a safe screen before re-rendering the subtree, so the failing
 * screen isn't immediately re-entered into another crash loop.
 */
import { Component, type ReactNode } from 'react';
import { captureError } from '../lib/analytics';
import { useApp } from '../state/store';

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Fail loud: the console for the developer, the relay for the operator —
    // a caught crash used to be invisible outside the player's own devtools
    // (audit 2026-09-05 WEB-01). Name/message/screen only, never the stack.
    console.error('[overlay] render crash — caught by ErrorBoundary:', error);
    captureError('error', {
      message: error.message, name: error.name, source: 'react-boundary',
      boundary: 'overlay', screen: useApp.getState().screen,
    });
  }

  private reset = (): void => {
    // Route to a safe screen FIRST (external store, applies synchronously), then
    // clear the error so children re-render there rather than at the crash site.
    // 'base' is only safe once server state exists: with store.base null the base
    // screen renders ZERO interactive elements (BaseHud bails before the navbar)
    // and nothing refetches /base — a first-session crash on loading/title/entry
    // would land on a dead screen whose only escape was a page reload. Title owns
    // its own auth/entry routing, so it is the safe target in that state.
    const s = useApp.getState();
    s.setScreen(s.base ? 'base' : 'title');
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="interactive" style={{
        position: 'absolute', inset: 0, zIndex: 5000, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 14, textAlign: 'center',
        padding: 24, background: 'rgba(16,14,20,.92)', color: '#e9e2d0',
      }}>
        <div style={{ fontSize: 22, letterSpacing: '2px' }}>SOMETHING BROKE</div>
        <div style={{ fontSize: 15, color: '#b0a894', maxWidth: 360, lineHeight: 1.5 }}>
          The interface hit an error. Your base is safe on the server.
        </div>
        <button onClick={this.reset} style={{
          marginTop: 8, padding: '10px 22px', background: '#caa04a', border: '2px solid #1b1720',
          color: '#1b1720', fontSize: 16, letterSpacing: '1px', cursor: 'pointer',
        }}>
          BACK TO BASE
        </button>
        {import.meta.env.DEV && (
          <pre style={{
            maxWidth: '90%', maxHeight: 200, overflow: 'auto', fontSize: 12,
            color: '#c75a2e', textAlign: 'left', whiteSpace: 'pre-wrap',
          }}>
            {String(this.state.error.stack ?? this.state.error.message)}
          </pre>
        )}
      </div>
    );
  }
}
