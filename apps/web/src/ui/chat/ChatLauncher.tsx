import { CHAT } from '@shardkeep/shared';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Screen } from '../../state/store';
import { useApp } from '../../state/store';
import { baseChatPlacement, mapChatSlot, useWindowSize } from '../layout';
import { COLORS as C } from '../primitives';
import { chatApi, chatUnavailable, startChatPoller, type ChatStatus } from './protocol';
import { useChatFrame } from './useChatFrame';
import type { ChatOwnerBridge } from './ChatScreen';

const ChatScreen = lazy(() => import('./ChatScreen'));

// World and campaign need the whole screen; leaving the base retires both
// the launcher and an already-open chat, including its polling lifecycle.
const CHAT_SCREENS = new Set<Screen>(['base', 'build']);

function ChatGlyph(): React.JSX.Element {
  return (
    <span aria-hidden="true" style={{
      width: 23, height: 17, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      border: `2px solid ${C.goldHi}`, color: C.goldHi, fontSize: 14, lineHeight: 1,
      boxShadow: `3px 3px 0 ${C.ink}`,
    }}>•••</span>
  );
}

/** Capability-gated floating launcher. The large chat UI remains a lazy chunk;
 * this tiny probe is all the first-paint graph carries. */
export function ChatLauncher({ ownerBridge }: { ownerBridge?: ChatOwnerBridge } = {}): React.JSX.Element {
  const wallet = useApp((state) => state.wallet);
  // Account switches retire cursors, unread pings and outstanding panel reads.
  return <WalletChatLauncher key={wallet ?? 'signed-out'} {...(ownerBridge ? { ownerBridge } : {})} />;
}

function WalletChatLauncher({ ownerBridge }: { ownerBridge?: ChatOwnerBridge }): React.JSX.Element | null {
  const authed = useApp((state) => state.authed);
  const screen = useApp((state) => state.screen);
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [capabilityMissing, setCapabilityMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState<Map<string, boolean>>(() => new Map());
  const unread = unreadMessages.size;
  const mentions = [...unreadMessages.values()].filter(Boolean).length;
  const cursor = useRef('0');
  const statusRef = useRef(status);
  statusRef.current = status;
  const launcher = useRef<HTMLButtonElement>(null);
  const eligible = authed && CHAT_SCREENS.has(screen);
  const win = useWindowSize();
  const frame = useChatFrame(win.h);
  const closeChat = useCallback((nextCursor: string, nextStatus: ChatStatus) => {
    cursor.current = nextCursor;
    setStatus(nextStatus);
    setUnreadMessages(new Map());
    setOpen(false);
    requestAnimationFrame(() => launcher.current?.focus());
  }, []);

  const statusEnabled = status?.enabled === true;
  useEffect(() => {
    if (!eligible) {
      setOpen(false);
      setStatus(null);
      setUnreadMessages(new Map());
      setCapabilityMissing(false);
      return;
    }
    if (statusEnabled || capabilityMissing) return;
    return startChatPoller({
      delayMs: () => statusRef.current?.pollClosedMs ?? CHAT.pollClosedMs,
      poll: async (isCurrent) => {
        const next = await chatApi.status();
        if (!isCurrent()) return;
        if (next.enabled) cursor.current = next.latestEventId;
        setStatus(next);
      },
      onError: (error) => {
        if (chatUnavailable(error)) setCapabilityMissing(true);
      },
    });
  }, [capabilityMissing, eligible, statusEnabled]);

  useEffect(() => {
    if (!eligible || open || !status?.enabled) return;
    return startChatPoller({
      delayMs: () => status.pollClosedMs,
      poll: async (isCurrent) => {
        const page = await chatApi.events(cursor.current);
        if (!isCurrent()) return;
        cursor.current = page.nextAfter;
        setUnreadMessages((current) => {
          const next = new Map(current);
          for (const event of page.events) {
            if (event.type === 'redaction') next.delete(event.messageId);
            else next.set(event.messageId, event.message.mentioned === true);
          }
          return new Map([...next].slice(-CHAT.domMessageLimit));
        });
      },
      onError: (error) => {
        if (chatUnavailable(error)) {
          setStatus(null);
        } else {
          void chatApi.status().then((next) => {
            if (!next.enabled) setStatus(null);
            else setStatus(next);
          }).catch(() => undefined);
        }
      },
    });
  }, [eligible, open, status]);

  if (!eligible || !status?.enabled) return null;
  const map = screen === 'map';
  const mapSlot = mapChatSlot();
  const basePlacement = baseChatPlacement(win.w, win.h);
  const launcherPosition = map
    ? ({
        '--chat-launcher-left': `${mapSlot.left}px`,
        '--chat-launcher-top': `${mapSlot.top}px`,
        left: 'calc(var(--chat-launcher-left) + env(safe-area-inset-left))',
        top: 'calc(var(--chat-launcher-top) + env(safe-area-inset-top))',
      } as CSSProperties)
    : ({
        '--chat-launcher-right': `${basePlacement.right}px`,
        '--chat-launcher-bottom': `${basePlacement.bottom}px`,
        right: 'calc(var(--chat-launcher-right) + env(safe-area-inset-right))',
        bottom: 'calc(var(--chat-launcher-bottom) + env(safe-area-inset-bottom))',
      } as CSSProperties);
  // Mirror ChatScreen's dock breakpoint so the loading fallback occupies the
  // same box the loaded panel will (M23 a5: PC chat is a dock, not full-screen).
  const dock = win.w >= 900 && frame.height >= 600;
  const fallbackBox = dock
    ? {
        right: 12, top: frame.top + frame.height - Math.min(560, frame.height - 24) - 12,
        width: 380, height: Math.min(560, frame.height - 24),
        border: `2px solid ${C.borderLt}`, outline: `2px solid ${C.ink}`,
        boxShadow: `6px 6px 0 ${C.ink}`,
      }
    : { left: 0, right: 0, top: frame.top, height: frame.height };
  return (
    <>
      {!open && (
        <button
          ref={launcher}
          className="interactive"
          type="button"
          aria-label={unread > 0 ? `Open global chat, ${unread} unread${mentions ? `, ${mentions} mention${mentions === 1 ? '' : 's'}` : ''}` : 'Open global chat'}
          onClick={() => { setUnreadMessages(new Map()); setOpen(true); }}
          style={{
            // Below every dialog and bottom sheet (ModalWrap 1500, sheets
            // 1050+) but above the plain HUD chrome (1000): the launcher must
            // never ride on top of an open dialog (M23 a5, the owner's
            // "overflowing dialog boxes" complaint). On the map its slot is
            // solver-reserved, so nothing at this level overlaps it either.
            position: 'absolute', zIndex: 1010,
            ...launcherPosition,
            width: map ? mapSlot.width : 48, height: map ? mapSlot.height : 48,
            padding: 0, display: 'grid', placeItems: 'center',
            background: C.card, border: `2px solid ${unread ? C.gold : C.borderLt}`,
            // Panel9's ink second edge — as a shadow ring, NOT `outline`, so the
            // keyboard focus ring on this button stays visible.
            boxShadow: `inset 0 2px 0 ${C.borderLt}, inset 0 -3px 0 ${C.ink}, 0 0 0 2px ${C.ink}`,
            cursor: 'pointer', fontFamily: 'inherit',
          }}>
          <ChatGlyph />
          {unread > 0 && (
            <span aria-hidden="true" style={{
              position: 'absolute', top: -8, right: -6, minWidth: 21, height: 21,
              padding: '0 4px', display: 'grid', placeItems: 'center', boxSizing: 'border-box',
              color: C.ink, background: C.gold, border: `2px solid ${C.ink}`, fontSize: 14,
            }}>{mentions > 0 ? `@${mentions > 99 ? '99+' : mentions}` : unread > 99 ? '99+' : unread}</span>
          )}
        </button>
      )}
      {open && (
        <Suspense fallback={<div className="interactive" role="dialog" {...(dock ? {} : { 'aria-modal': 'true' })} aria-label="Loading global chat"
          style={{ position: 'fixed', ...fallbackBox, zIndex: 3000, display: 'grid', placeItems: 'center', background: C.bg }}>
          <div role="status" style={{ color: C.gold, fontSize: 20, letterSpacing: '2px' }}>LOADING GLOBAL CHAT…</div>
          <button type="button" aria-label="Close global chat" onClick={() => closeChat(cursor.current, status)}
            style={{ position: 'absolute', top: 'max(10px, env(safe-area-inset-top))', left: 10,
              width: 44, height: 44, color: C.text, background: C.card, border: `2px solid ${C.borderLt}`,
              boxShadow: 'inset 0 2px 0 rgba(244,215,123,.12), inset 0 -3px 0 rgba(0,0,0,.5)', cursor: 'pointer' }}>×</button>
        </div>}>
          <ChatScreen
            {...(ownerBridge ? { ownerBridge } : {})}
            initialStatus={status}
            initialCursor={cursor.current}
            onClose={closeChat}
          />
        </Suspense>
      )}
    </>
  );
}
