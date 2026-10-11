/** Branded confirmation opened only by Android/TWA Back-sensitive actions. */
import { useMobileBackHandler } from '../lib/mobileBackGuard';
import { Btn, COLORS as C, ModalWrap, Phead } from './primitives';

export function MobileBackConfirm({
  title, body, confirmLabel, onConfirm, onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
}): React.JSX.Element {
  // The confirmation owns Back above the surface that opened it. Otherwise a
  // second Android gesture reaches that surface and merely opens the same modal
  // again, leaving the player trapped until they tap STAY.
  useMobileBackHandler(() => {
    onCancel();
    return true;
  }, true, 1_000);

  return (
    <ModalWrap onBackdrop={onCancel}>
      <div role="alertdialog" aria-modal="true" aria-label={title}>
        <Phead title={title} onClose={onCancel} fontSize={21} />
        <div style={{ padding: '14px 16px 16px', display: 'grid', gap: 14 }}>
          <div style={{ color: C.textDim, fontSize: 18, lineHeight: 1.25 }}>{body}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Btn variant="ghost" fontSize={17} onClick={onCancel}>STAY</Btn>
            <Btn variant="sec" fontSize={17} onClick={onConfirm}>{confirmLabel}</Btn>
          </div>
        </div>
      </div>
    </ModalWrap>
  );
}
