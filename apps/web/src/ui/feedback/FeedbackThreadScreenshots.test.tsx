/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import { FeedbackThreadScreenshots, type FeedbackUploadSlot } from './FeedbackThreadScreenshots';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { postBinary, getBlob } = vi.hoisted(() => ({ postBinary: vi.fn(), getBlob: vi.fn() }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: { postBinary, getBlob } }));
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  useApp.setState({ wallet: 'owner' });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  getBlob.mockResolvedValue(new Blob(['image']));
});
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); postBinary.mockReset(); getBlob.mockReset(); });
const button = (host: HTMLElement, label: string): HTMLButtonElement => {
  const node = [...host.querySelectorAll('button')].find(b => b.textContent === label);
  if (!node) throw new Error(`Missing ${label}`); return node;
};
async function mount(initial: FeedbackUploadSlot[] = []) {
  let slots = initial;
  const changed = vi.fn(), busy = vi.fn();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = (): void => root.render(<FeedbackThreadScreenshots path="/tester/feedback/report" wallet="owner" scopeKey="owner:report"
    ids={slots.flatMap(s => s.attachmentId ? [s.attachmentId] : [])} slots={slots} disabled={false}
    onBusy={busy} onChange={next => { changed(next); slots = next; render(); }} />);
  await act(async () => render());
  cleanup.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, changed, busy, slots: () => slots,
    set: async (next: FeedbackUploadSlot[]) => { slots = next; await act(async () => render()); },
    choose: async () => { const field = host.querySelector<HTMLInputElement>('input[type=file]')!;
      Object.defineProperty(field, 'files', { configurable: true, value: [new File(['image'], 'image.png', { type: 'image/png' })] });
      await act(async () => field.dispatchEvent(new Event('change', { bubbles: true }))); },
    upload: async () => { await act(async () => button(host, 'UPLOAD SELECTED SCREENSHOTS').click()); } };
}

it('locks every removal control while a request is uncertain and re-enables after failure without parent busy state', async () => {
  let reject!: (error: Error) => void;
  postBinary.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const view = await mount([{ requestId: 'old', attachmentId: 'old-image' }, { requestId: 'missing-one' }, { requestId: 'missing-two' }]);
  await view.choose(); await view.upload();
  expect(button(view.host, 'REMOVE UPLOADED SCREENSHOT 1').disabled).toBe(true);
  expect(button(view.host, 'CLEAR MISSING FILES').disabled).toBe(true);
  await act(async () => button(view.host, 'CLEAR MISSING FILES').click());
  expect(view.slots().map(s => s.requestId)).toEqual(['old', 'missing-one', 'missing-two']);
  await act(async () => reject(new Error('Response lost')));
  expect(button(view.host, 'REMOVE UPLOADED SCREENSHOT 1').disabled).toBe(false);
  expect(button(view.host, 'CLEAR MISSING FILES').disabled).toBe(false);
  expect(button(view.host, 'UPLOAD SELECTED SCREENSHOTS').disabled).toBe(false);
  expect(view.busy.mock.calls.map(call => call[0])).toEqual([true, false]);
});

it('merges an accepted upload into the latest slot order without restoring a removed image or losing new evidence', async () => {
  let resolve!: (image: { id: string }) => void;
  postBinary.mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = await mount([{ requestId: 'old', attachmentId: 'old-image' }]);
  await view.choose(); const pending = view.slots()[1]!; await view.upload();
  await view.set([{ requestId: 'new', attachmentId: 'new-image' }, pending]);
  await act(async () => resolve({ id: 'accepted-image' }));
  expect(view.slots()).toEqual([{ requestId: 'new', attachmentId: 'new-image' }, { ...pending, attachmentId: 'accepted-image' }]);
  expect(view.host.textContent).not.toContain('UPLOAD SELECTED SCREENSHOTS');
  expect(button(view.host, 'REMOVE UPLOADED SCREENSHOT 1').disabled).toBe(false);
  expect(postBinary).toHaveBeenCalledOnce();
});

it('does not resurrect a removed pending slot when its upload response arrives', async () => {
  let resolve!: (image: { id: string }) => void;
  postBinary.mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = await mount(); await view.choose(); await view.upload();
  await view.set([{ requestId: 'replacement', attachmentId: 'replacement-image' }]);
  await act(async () => resolve({ id: 'unused-upload' }));
  expect(view.slots()).toEqual([{ requestId: 'replacement', attachmentId: 'replacement-image' }]);
  expect(postBinary).toHaveBeenCalledOnce();
});
