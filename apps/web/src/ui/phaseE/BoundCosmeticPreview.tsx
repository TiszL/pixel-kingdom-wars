import { useEffect, useRef, useState } from 'react';
import type { BoundCosmeticAppearance } from '@shardkeep/shared/boundCosmeticApi';
import { loadCosmeticPreview, type LoadedCosmeticPreview } from '../../lib/boundCosmetics/preview';
import './bound-cosmetic-preview.css';

export interface BoundCosmeticPreviewProps {
  appearance: BoundCosmeticAppearance;
  label: string;
  /** The system reduced-motion preference always wins over automatic playback. */
  animation?: 'auto' | 'paused';
}
type PreviewState = { key: string; result: LoadedCosmeticPreview | null; failed: boolean };

/** Exact appearance preview only; no equipment, entitlement or spending action. */
export function BoundCosmeticPreview({ appearance, label, animation = 'auto' }: BoundCosmeticPreviewProps) {
  const identity = JSON.stringify(appearance);
  const [state, setState] = useState<PreviewState | null>(null), [retry, setRetry] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [scale, setScale] = useState(1);
  const canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null);
  const key = `${identity}:${retry}`;
  const current = state?.key === key ? state : null;
  const result = current?.result ?? null;
  const moving = animation === 'auto' && !reduced && !paused;

  useEffect(() => {
    const controller = new AbortController(); let resource: LoadedCosmeticPreview | null = null, active = true;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void loadCosmeticPreview(JSON.parse(identity) as BoundCosmeticAppearance, controller.signal).then(value => {
      if (controller.signal.aborted) { value.bitmap.close(); return; }
      resource = value; setState({ key, result: value, failed: false });
    }).catch(() => {
      // One failed parallel asset must also cancel its still-pending siblings.
      controller.abort();
      // Cleanup cancellation cannot publish into a replacement appearance.
      if (active) setState({ key, result: null, failed: true });
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; controller.abort(); clearTimeout(timeout); resource?.bitmap.close(); };
  }, [identity, key]);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    if (!result || !stage.current) return;
    const node = stage.current;
    const resize = () => setScale(node.clientWidth >= result.width * 2 ? 2 : 1);
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [result]);

  useEffect(() => {
    const node = canvas.current;
    if (!result || !node) return;
    const context = node.getContext('2d');
    if (!context) return;
    context.imageSmoothingEnabled = false;
    let raf = 0, start: number | null = null, previous = -1;
    const draw = (index: number) => {
      if (index === previous) return;
      previous = index;
      const frame = result.frames[index]!;
      context.clearRect(0, 0, result.width, result.height);
      context.drawImage(result.bitmap, frame.x, frame.y, frame.w, frame.h, 0, 0, result.width, result.height);
    };
    const tick = (time: number) => {
      if (document.visibilityState === 'hidden') return;
      start ??= time;
      const step = Math.floor((time - start) * result.fps / 1000);
      draw(result.loop ? step % result.frames.length : Math.min(step, result.frames.length - 1));
      if (result.loop || step < result.frames.length - 1) raf = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(raf); start = null;
      draw(result.reducedMotionFrame);
      if (moving && result.frames.length > 1 && document.visibilityState !== 'hidden') raf = requestAnimationFrame(tick);
    };
    resume(); document.addEventListener('visibilitychange', resume);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', resume); };
  }, [result, moving]);

  return <figure className="sk-bound-preview" aria-label={`${label} preview`}>
    <div className="sk-bound-preview-title"><span>{label}</span><span className="sk-bound-preview-tag">PREVIEW</span></div>
    <div className="sk-bound-preview-stage" ref={stage} aria-busy={!current}>
      {result ? <canvas ref={canvas} width={result.width} height={result.height} style={{ width: result.width * scale, height: result.height * scale }} role="img" aria-label={`${label} appearance`} />
        : <p role="status">{current?.failed ? 'Preview unavailable. Try again in a moment.' : 'Loading appearance…'}</p>}
    </div>
    <figcaption className="sk-bound-preview-footer">
      <span>{result && (reduced || animation === 'paused') ? 'Still preview' : 'Appearance preview'}</span>
      {current?.failed ? <button type="button" onClick={() => setRetry(value => value + 1)}>TRY AGAIN</button>
        : result && result.frames.length > 1 && !reduced && animation === 'auto' ? <button type="button" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? 'PLAY ANIMATION' : 'PAUSE ANIMATION'}</button> : null}
    </figcaption>
  </figure>;
}
