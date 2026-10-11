/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_SCREENSHOTS } from '@shardkeep/shared/feedback';
import FeedbackScreenshotPicker, { type FeedbackScreenshotDraft } from './FeedbackScreenshotPicker';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const image = (type = 'image/png', size = 1): File => new File([new Uint8Array(size)], 'private-long-filename'.repeat(20) + '.png', { type });
const item = (id = 'one', scopeKey = 'wallet:report:reply'): FeedbackScreenshotDraft => ({ id, scopeKey, file: image(), status: 'selected' });
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  let sequence = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++sequence}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); vi.restoreAllMocks(); });
async function mount(initial: FeedbackScreenshotDraft[] = []) {
  let items = initial; let scopeKey = 'wallet:report:reply';
  const changed = vi.fn(); const retry = vi.fn();
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const render = (): void => { root.render(<FeedbackScreenshotPicker scopeKey={scopeKey} items={items} onRetry={retry}
    onChange={(next) => { changed(next); items = next; render(); }} />); };
  await act(async () => render());
  const unmount = async (): Promise<void> => { await act(async () => root.unmount()); host.remove(); };
  cleanup.push(unmount);
  return { host, changed, retry, items: () => items,
    set: async (next: FeedbackScreenshotDraft[], scope = scopeKey) => { items = next; scopeKey = scope; await act(async () => render()); },
    unmount: async () => { cleanup.splice(cleanup.indexOf(unmount), 1); await unmount(); } };
}
async function choose(host: HTMLElement, files: File[]) {
  const field = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(field, 'files', { configurable: true, value: files });
  await act(async () => field.dispatchEvent(new Event('change', { bubbles: true })));
}
async function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === label || node.textContent === label);
  if (!found) throw new Error(`Missing ${label}`);
  await act(async () => found.click());
}

describe('local feedback screenshots', () => {
  it('selects supported files locally through the normal picker without uploading or exposing filenames', async () => {
    const network = vi.spyOn(globalThis, 'fetch'); const { host, items, changed } = await mount();
    const field = host.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(field.accept).toBe('image/jpeg,image/png,image/webp'); expect(field.hasAttribute('capture')).toBe(false);
    const files = [image('image/jpeg'), image('image/png'), image('image/webp')]; await choose(host, files);
    expect(changed).toHaveBeenCalledOnce(); expect(items().map((value) => value.file)).toEqual(files);
    expect(host.querySelectorAll('img')).toHaveLength(3); expect(network).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('private-long-filename');
    expect([...host.querySelectorAll('button')].every((node) => node.style.minHeight === '44px')).toBe(true);
    expect(field.value).toBe('');
  });

  it('rejects oversized, empty or unsupported selections atomically without replacing existing evidence', async () => {
    const existing = item(); const { host, items, changed } = await mount([existing]);
    for (const invalid of [image('image/png', FEEDBACK_SCREENSHOTS.maxUploadBytes + 1), image('image/png', 0), image('image/svg+xml')]) {
      await choose(host, [image(), invalid]);
      expect(items()).toEqual([existing]); expect(changed).not.toHaveBeenCalled(); expect(host.querySelector('[role=alert]')).not.toBeNull();
    }
    await choose(host, [image('image/png', FEEDBACK_SCREENSHOTS.maxUploadBytes)]);
    expect(items()).toHaveLength(2);
  });

  it('enforces the message cap and permits an explicit one-for-one change at the cap', async () => {
    const existing = Array.from({ length: FEEDBACK_SCREENSHOTS.maxPerMessage }, (_, index) => item(`image-${index}`));
    const { host, items } = await mount(existing);
    await choose(host, [image()]); expect(items()).toEqual(existing);
    await button(host, 'Change screenshot 1'); const replacement = image('image/webp');
    await choose(host, [replacement]); expect(items()).toHaveLength(FEEDBACK_SCREENSHOTS.maxPerMessage);
    expect(items()[0]!.file).toBe(replacement); expect(items().slice(1)).toEqual(existing.slice(1));
  });

  it('revokes preview URLs on removal, replacement, identity reset and unmount', async () => {
    const first = item(); const second = item('two'); const view = await mount([first, second]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    await button(view.host, 'Remove screenshot 1'); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
    await button(view.host, 'Change screenshot 1'); await choose(view.host, [image()]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-2');
    await view.set(view.items(), 'other-wallet:report:reply');
    expect(view.host.querySelector('img')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-3');
    await view.set([item('other', 'other-wallet:report:reply')], 'other-wallet:report:reply');
    await view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-4');
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4);
  });

  it('keeps the file after preview failure and retries only the preview on explicit click', async () => {
    const original = item(); const { host, items, retry } = await mount([original]);
    await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(items()).toEqual([original]); expect(host.textContent).toContain('THE SELECTED FILE IS KEPT');
    await button(host, 'RETRY PREVIEW'); expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1'); expect(retry).not.toHaveBeenCalled();
    expect(host.querySelector('img')?.src).toBe('blob:test-2');
  });

  it('shows upload retry state from the parent without invoking its callback automatically', async () => {
    const failed = { ...item(), status: 'error' as const, error: 'Network unavailable' };
    const view = await mount([failed]); expect(view.retry).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain('Network unavailable'); await button(view.host, 'Retry screenshot 1');
    expect(view.retry).toHaveBeenCalledExactlyOnceWith(failed.id);
    await view.set([{ ...failed, status: 'uploading' }]);
    expect(view.host.textContent).toContain('UPLOADING…');
    expect(view.host.querySelector<HTMLButtonElement>('button[aria-label="Remove screenshot 1"]')?.disabled).toBe(true);
  });
});
