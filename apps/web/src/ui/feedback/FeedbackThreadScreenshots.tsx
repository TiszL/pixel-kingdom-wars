import { FEEDBACK_SCREENSHOTS as LIMIT, type FeedbackAttachmentDto } from '@shardkeep/shared/feedback';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, btnStyle, COLORS as C } from '../primitives';
import Picker, { type FeedbackScreenshotDraft } from './FeedbackScreenshotPicker';

/** Private bytes are fetched through authenticated transport, never placed in
 * a token-bearing URL. Unmount/account changes abort reads and revoke URLs. */
export function FeedbackPrivateImage({ path, wallet, attachment }: {
  path: string; wallet: string; attachment: FeedbackAttachmentDto;
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const currentWallet = useApp((state) => state.wallet);
  useEffect(() => {
    if (attachment.expired) return undefined;
    const ctrl = new AbortController(); let local: string | null = null;
    const revoke = (): void => { if (local) { URL.revokeObjectURL(local); local = null; } };
    const unsubscribe = useApp.subscribe((state) => { if (state.wallet !== wallet) { ctrl.abort(); revoke(); setUrl(null); setExpanded(false); } });
    setUrl(null); setError(null); setExpanded(false);
    void api.getBlob(`${path}/screenshots/${encodeURIComponent(attachment.id)}`, { signal: ctrl.signal }).then((blob) => {
      if (ctrl.signal.aborted || useApp.getState().wallet !== wallet) return;
      local = URL.createObjectURL(blob); setUrl(local);
    }).catch((cause: unknown) => {
      if (!ctrl.signal.aborted) setError(cause instanceof ApiError && cause.status === 410 ? 'SCREENSHOT EXPIRED' : 'SCREENSHOT UNAVAILABLE');
    });
    return () => { ctrl.abort(); unsubscribe(); revoke(); };
  }, [attachment.expired, attachment.id, attempt, path, wallet]);
  if (currentWallet !== wallet) return <></>;
  if (attachment.expired) return <div>SCREENSHOT EXPIRED</div>;
  return <div style={{ minWidth: 0 }}>{url && !error && <>
    <button type="button" className="interactive" aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)} style={{ ...btnStyle('sec', 16), minHeight: 44, width: '100%' }}>
      {expanded ? 'FIT SCREENSHOT' : 'VIEW FULL SIZE'}
    </button>
    {expanded && <div style={{ fontSize: 14, color: C.textDim }}>Scroll the image to read its details. FIT SCREENSHOT returns to the preview.</div>}
    <div style={{ overflow: expanded ? 'auto' : 'hidden', maxHeight: expanded ? 'min(65vh, 620px)' : 280 }}
      tabIndex={expanded ? 0 : undefined} role={expanded ? 'region' : undefined}
      aria-label={expanded ? 'Full-size private screenshot' : undefined}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); } }}>
      <img src={url} alt="Private feedback screenshot" onError={() => setError('SCREENSHOT UNAVAILABLE')}
        style={{ width: expanded ? 'auto' : '100%', maxWidth: expanded ? 'none' : '100%', maxHeight: expanded ? 'none' : 280, objectFit: 'contain', display: 'block' }} />
    </div>
  </>}
    {!url && !error && <span>LOADING SCREENSHOT…</span>}{error && <div role="status">{error} {error !== 'SCREENSHOT EXPIRED' && <Btn onClick={() => setAttempt((n) => n + 1)} style={{ minHeight: 44 }}>RETRY IMAGE</Btn>}</div>}</div>;
}
const dto = (id: string): FeedbackAttachmentDto => ({ id, width: null, height: null, byteLength: null, contentType: null, expired: false });
export interface FeedbackUploadSlot { requestId: string; attachmentId?: string }
export function FeedbackThreadScreenshots({ path, wallet, scopeKey, ids, slots, disabled, onChange, onBusy }: {
  path: string; wallet: string; scopeKey: string; ids: readonly string[]; slots: readonly FeedbackUploadSlot[]; disabled: boolean;
  /** Must persist before returning. Throws when the exact draft cannot be saved. */
  onChange: (slots: FeedbackUploadSlot[]) => void; onBusy: (busy: boolean) => void;
}): React.JSX.Element {
  const [items, setItems] = useState<FeedbackScreenshotDraft[]>([]), [error, setError] = useState<string | null>(null);
  const alive = useRef(false), ctrl = useRef<AbortController | null>(null), uploading = useRef(false);
  const [isUploading, setIsUploading] = useState(false);
  const latestSlots = useRef(slots); latestSlots.current = slots;
  useEffect(() => {
    alive.current = true;
    const unsubscribe = useApp.subscribe((state) => { if (state.wallet !== wallet) ctrl.current?.abort(); });
    return () => { alive.current = false; ctrl.current?.abort(); unsubscribe(); };
  }, [wallet]);
  const missing = slots.filter(s => !s.attachmentId && !items.some(i => i.id === s.requestId));
  const change = (next: FeedbackScreenshotDraft[]): void => {
    if (disabled || uploading.current) return;
    try {
      if (ids.length + next.length > LIMIT.maxPerMessage) throw new Error(`A reply allows ${LIMIT.maxPerMessage} screenshots including those already uploaded.`);
      const available = missing.filter(s => !next.some(i => i.id === s.requestId));
      const mapped = next.map(item => slots.some(s => s.requestId === item.id) ? item : { ...item, id: available.shift()?.requestId ?? item.id });
      const retained = slots.filter(s => s.attachmentId || mapped.some(i => i.id === s.requestId) || missing.some(m => m.requestId === s.requestId));
      const additions = mapped.filter(i => !retained.some(s => s.requestId === i.id)).map(i => ({ requestId: i.id }));
      onChange([...retained, ...additions]); setItems(mapped); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save screenshot selection.'); }
  };
  const upload = async (onlyId?: string): Promise<void> => {
    if (disabled || uploading.current || useApp.getState().wallet !== wallet) return;
    uploading.current = true; setIsUploading(true); onBusy(true); setError(null);
    const controller = new AbortController(); ctrl.current = controller;
    try {
      for (const item of items.filter((i) => !onlyId || i.id === onlyId)) {
        // A parent refresh may remove a slot while an earlier upload is pending.
        if (!latestSlots.current.some(s => s.requestId === item.id && !s.attachmentId)) continue;
        setItems((old) => old.map((i) => i.id === item.id ? { ...i, status: 'uploading', error: '' } : i));
        try {
          const image = await api.postBinary<FeedbackAttachmentDto>(`${path}/screenshots/${encodeURIComponent(item.id)}`, item.file, { signal: controller.signal });
          if (!alive.current || controller.signal.aborted || useApp.getState().wallet !== wallet) return;
          // Merge only this receipt into the current selection. Never restore a
          // removed image or overwrite a newer slot/order from the parent.
          if (latestSlots.current.some(s => s.requestId === item.id && !s.attachmentId)) {
            const next = latestSlots.current.map(s => s.requestId === item.id ? { ...s, attachmentId: image.id } : s);
            onChange(next); latestSlots.current = next;
          }
          setItems(old => old.filter(i => i.id !== item.id));
        } catch (cause) {
          if (!alive.current || controller.signal.aborted) return;
          const message = cause instanceof Error ? cause.message : 'Upload failed. Retry this screenshot.';
          setItems((old) => old.map((i) => i.id === item.id ? { ...i, status: 'error', error: message } : i));
          break; // Later images remain selected; never retry a failure automatically.
        }
      }
    } finally { uploading.current = false; ctrl.current = null; if (alive.current) { setIsUploading(false); onBusy(false); } }
  };
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div style={{ color: C.textDim, fontSize: 14 }}>Up to {LIMIT.maxPerMessage} screenshots per reply and {LIMIT.maxPerThread - LIMIT.maxStaffPerThread} uploads from you per thread. Removing an upload here does not free its thread slot.</div>
    {ids.map((id, index) => <div key={id}><FeedbackPrivateImage path={path} wallet={wallet} attachment={dto(id)} />
      <Btn disabled={disabled || isUploading} onClick={() => { if (disabled || uploading.current) return; try { onChange(latestSlots.current.filter(s => s.attachmentId !== id)); } catch (cause) { setError(String(cause)); } }} style={{ minHeight: 44 }}>REMOVE UPLOADED SCREENSHOT {index + 1}</Btn></div>)}
    {missing.length > 0 && <div role="status">Local image files were not restored. Reattach the original files in the same order, or keep only your text and uploaded screenshots.
      <Btn disabled={disabled || isUploading} onClick={() => { if (disabled || uploading.current) return; try { onChange(latestSlots.current.filter(s => !missing.some(m => m.requestId === s.requestId))); } catch (cause) { setError(String(cause)); } }} style={{ minHeight: 44 }}>CLEAR MISSING FILES</Btn></div>}
    <Picker scopeKey={scopeKey} items={items} onChange={change} disabled={disabled || isUploading} onRetry={(id) => { void upload(id); }} />
    {items.length > 0 && <Btn disabled={disabled || isUploading} onClick={() => { void upload(); }} style={{ minHeight: 44 }}>UPLOAD SELECTED SCREENSHOTS</Btn>}
    {error && <div role="alert">{error}</div>}
  </div>;
}
