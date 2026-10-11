import { FEEDBACK_SCREENSHOTS } from '@shardkeep/shared/feedback';
import { useEffect, useRef, useState } from 'react';
import { Btn, Chip, COLORS as C, btnStyle } from '../primitives';

export interface FeedbackScreenshotDraft {
  id: string;
  /** Wallet + actor mode + report/composer identity, supplied by the caller. */
  scopeKey: string;
  file: File;
  status?: 'selected' | 'uploading' | 'uploaded' | 'error';
  error?: string;
}
export interface FeedbackScreenshotPickerProps {
  scopeKey: string;
  items: readonly FeedbackScreenshotDraft[];
  onChange: (items: FeedbackScreenshotDraft[]) => void;
  disabled?: boolean;
  /** Explicit user retry only. The picker never starts an upload itself. */
  onRetry?: (id: string) => void;
}
const ACCEPT = 'image/jpeg,image/png,image/webp';

/** A local-only controlled picker. Preview URLs stay inside the component;
 * the caller decides when confirmed files may be uploaded. */
export default function FeedbackScreenshotPicker(props: FeedbackScreenshotPickerProps): React.JSX.Element {
  return <PickerSession key={props.scopeKey} {...props} />;
}

function PickerSession({ scopeKey, items, onChange, disabled = false, onRetry }: FeedbackScreenshotPickerProps): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(false);
  const replacement = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = items.filter((item) => item.scopeKey === scopeKey);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const open = (id: string | null): void => {
    replacement.current = id;
    if (input.current) { input.current.multiple = id === null; input.current.value = ''; input.current.click(); }
  };
  const choose = (files: File[]): void => {
    if (!alive.current || disabled || !files.length) return;
    const replacing = replacement.current;
    const target = replacing ? current.find((item) => item.id === replacing) : null;
    if (replacing && (!target || target.status === 'uploading')) { setError('This screenshot changed. Choose it again.'); return; }
    if (replacing && files.length !== 1) { setError('Choose one replacement screenshot.'); return; }
    if (current.length + files.length - (target ? 1 : 0) > FEEDBACK_SCREENSHOTS.maxPerMessage) {
      setError(`Choose at most ${FEEDBACK_SCREENSHOTS.maxPerMessage} screenshots per message. Remove one before adding more.`); return;
    }
    if (files.some((file) => !ACCEPT.split(',').includes(file.type))) { setError('Choose JPG, PNG, or WebP screenshots.'); return; }
    if (files.some((file) => file.size === 0 || file.size > FEEDBACK_SCREENSHOTS.maxUploadBytes)) {
      setError(`Each screenshot must contain image data and be no larger than ${FEEDBACK_SCREENSHOTS.maxUploadBytes / 1024 / 1024} MiB.`); return;
    }
    const chosen = files.map((file): FeedbackScreenshotDraft => ({ id: crypto.randomUUID(), scopeKey, file, status: 'selected' }));
    setError(null);
    onChange(target ? current.map((item) => item.id === target.id ? chosen[0]! : item) : [...current, ...chosen]);
  };
  return <section aria-label="Feedback screenshots" style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div>SCREENSHOTS · {current.length}/{FEEDBACK_SCREENSHOTS.maxPerMessage}</div>
    <div style={{ color: C.textDim, fontSize: 14 }}>Choose screenshots to include with your message. JPG, PNG or WebP, up to {FEEDBACK_SCREENSHOTS.maxUploadBytes / 1024 / 1024} MiB each. The server checks each image when submitted.</div>
    <input ref={input} className="interactive" type="file" accept={ACCEPT} multiple aria-label="Choose feedback screenshots" hidden
      disabled={disabled} onChange={(event) => { choose(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
    <Btn disabled={disabled || current.length >= FEEDBACK_SCREENSHOTS.maxPerMessage} onClick={() => open(null)} style={{ minHeight: 44 }}>ADD SCREENSHOTS</Btn>
    {error && <div role="alert" style={{ color: C.danger }}>{error}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 8, minWidth: 0 }}>
      {current.map((item, index) => <Chip key={item.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, minWidth: 0 }}>
        <ScreenshotPreview file={item.file} label={`Screenshot ${index + 1}`} />
        <div role="status" style={{ overflowWrap: 'anywhere' }}>{item.status === 'uploading' ? 'UPLOADING…' : item.status === 'uploaded' ? 'READY TO ATTACH' : item.status === 'error' ? 'UPLOAD NEEDS RETRY' : 'SELECTED — NOT SENT'}</div>
        {item.error && <div role="alert" style={{ color: C.danger, overflowWrap: 'anywhere' }}>{item.error}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="interactive" aria-label={`Change screenshot ${index + 1}`} disabled={disabled || item.status === 'uploading'}
            onClick={() => open(item.id)} style={{ ...btnStyle('ghost', 16, disabled || item.status === 'uploading'), minHeight: 44 }}>CHANGE</button>
          <button type="button" className="interactive" aria-label={`Remove screenshot ${index + 1}`} disabled={disabled || item.status === 'uploading'}
            onClick={() => { setError(null); onChange(current.filter((other) => other.id !== item.id)); }}
            style={{ ...btnStyle('ghost', 16, disabled || item.status === 'uploading'), minHeight: 44 }}>REMOVE</button>
          {item.status === 'error' && onRetry && <button type="button" className="interactive" aria-label={`Retry screenshot ${index + 1}`} disabled={disabled}
            onClick={() => onRetry(item.id)} style={{ ...btnStyle('gold', 16, disabled), minHeight: 44 }}>RETRY UPLOAD</button>}
        </div>
      </Chip>)}
    </div>
  </section>;
}

function ScreenshotPreview({ file, label }: { file: File; label: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setFailed(false);
    let local: string;
    try { local = URL.createObjectURL(file); setUrl(local); }
    catch { setUrl(null); setFailed(true); return undefined; }
    return () => { URL.revokeObjectURL(local); };
  }, [file, attempt]);
  return <>
    <span>{label}</span>
    {url && !failed && <img src={url} alt={label} onError={() => setFailed(true)}
      style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'contain' }} />}
    {failed && <div role="status">PREVIEW UNAVAILABLE — THE SELECTED FILE IS KEPT.
      <Btn onClick={() => setAttempt((old) => old + 1)} style={{ minHeight: 44 }}>RETRY PREVIEW</Btn>
    </div>}
  </>;
}
