/**
 * The real controls behind every "contact support" (D-098, owner 2026-09-02):
 * a mailto anchor, a COPY ADDRESS button and the Discord invite. The copy
 * button is not decoration — mailto: is inert inside the Android/dApp-store
 * WebView, so without it the anchor would be one more dead end there. The
 * reason a player is here is the caller's copy; this renders only the ways out.
 */
import { bus } from '../lib/events';
import { DISCORD_URL, SUPPORT_EMAIL, supportMailto, supportSubject } from '../lib/support';
import { useApp } from '../state/store';
import { Btn, COLORS as C } from './primitives';

const toast = (msg: string): void => bus.emit('ui:toast', { msg });

export function copySupportAddress(): void {
  void navigator.clipboard?.writeText(SUPPORT_EMAIL)
    .then(() => toast('SUPPORT ADDRESS COPIED'))
    .catch(() => toast('COPY FAILED — LONG-PRESS THE ADDRESS'));
}

export function SupportLinks({ topic, body, fontSize = 13 }: {
  /** Subject line; the signed-in wallet is appended so support can act on it. */
  topic: string;
  body?: string;
  fontSize?: number;
}): React.JSX.Element {
  const wallet = useApp((s) => s.wallet);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize }}>
      <a className="interactive" href={supportMailto(supportSubject(topic, wallet), body)}
        style={{ color: C.gold, wordBreak: 'break-all' }}>
        EMAIL SUPPORT · {SUPPORT_EMAIL}
      </a>
      <Btn variant="ghost" fontSize={fontSize} style={{ padding: '2px 8px 4px' }} onClick={copySupportAddress}>
        COPY ADDRESS
      </Btn>
      <a className="interactive" href={DISCORD_URL} target="_blank" rel="noopener noreferrer"
        style={{ color: C.gold }}>
        DISCORD ↗
      </a>
    </div>
  );
}
