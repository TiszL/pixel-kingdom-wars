import { useEffect, useRef, useState, type CSSProperties, type ImgHTMLAttributes } from 'react';
import { registerServiceWorker } from '../lib/sw';

type Props = Pick<ImgHTMLAttributes<HTMLImageElement>, 'width' | 'height' | 'loading' | 'decoding' | 'fetchPriority'> & {
  src: string;
  alt: string;
  style?: CSSProperties;
};

// UI transport recovery, not game timing. Reserve two further attempts for a
// worker takeover/connectivity restoration after the automatic budget runs out.
const RETRY_DELAYS = [300, 1_000, 2_500, 5_000];
const MAX_RETRIES = RETRY_DELAYS.length + 2;

/** A source change (including rotation) owns a fresh, isolated retry lifetime. */
export function BrandImage(props: Props): React.JSX.Element {
  return <BrandImageSource key={props.src} {...props} />;
}

function BrandImageSource({ src, alt, width, height, style, ...imageProps }: Props): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'failed' | 'loaded'>('loading');
  const retries = useRef(0);
  const loaded = useRef(false);
  const active = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const clearRetry = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const retry = (): void => {
    clearRetry();
    if (!active.current || loaded.current || retries.current >= MAX_RETRIES || !navigator.onLine) return;
    registerServiceWorker();
    retries.current += 1;
    setAttempt(retries.current);
    setState('loading');
  };
  const finish = (): void => {
    if (!active.current || attempt !== retries.current) return;
    loaded.current = true;
    clearRetry();
    setState('loaded');
  };

  useEffect(() => {
    active.current = true;
    // Cached images can finish before the passive effect; avoid leaving the
    // readable fallback in front of an already decoded image.
    if (image.current?.complete && image.current.naturalWidth > 0) finish();
    const worker = navigator.serviceWorker;
    window.addEventListener('online', retry);
    worker?.addEventListener('controllerchange', retry);
    return () => {
      active.current = false;
      clearRetry();
      window.removeEventListener('online', retry);
      worker?.removeEventListener('controllerchange', retry);
    };
  }, []);

  // Never remove/change v or use the pack-download bypass: an old page must
  // still fail closed if its own generation is no longer retained. A fresh URL
  // also avoids reusing a failed image decode/HTTP-cache entry after takeover.
  const imageSrc = attempt === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}imageRetry=${attempt}`;
  return (
    <span data-brand-state={state} style={{
      display: 'block', position: 'relative', pointerEvents: 'none',
      ...(width && height ? { aspectRatio: `${width} / ${height}` } : {}),
      ...style,
    }}>
      {state !== 'loaded' && alt && (
        <span style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          textAlign: 'center', color: '#f1ebd7', fontSize: 28, lineHeight: 1.2,
          textShadow: '2px 2px 0 #100f14',
        }}>{alt}</span>
      )}
      <img key={attempt} ref={image} {...imageProps} src={imageSrc} width={width} height={height}
        alt={alt} aria-hidden={state !== 'loaded'} onLoad={finish}
        onError={() => {
          if (!active.current || attempt !== retries.current) return;
          loaded.current = false;
          setState('failed');
          if (timer.current !== null || !navigator.onLine) return;
          const delay = RETRY_DELAYS[retries.current];
          if (delay !== undefined) timer.current = setTimeout(retry, delay);
        }}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: style?.objectFit, imageRendering: style?.imageRendering,
          // Decorative art has no readable fallback to protect. Hiding it until
          // React saw onLoad painted a dark frame whenever it remounted over the
          // same wallpaper (the pre-React boot and loading handoffs).
          visibility: state === 'loaded' || (!alt && state === 'loading') ? 'visible' : 'hidden',
        }} />
    </span>
  );
}
