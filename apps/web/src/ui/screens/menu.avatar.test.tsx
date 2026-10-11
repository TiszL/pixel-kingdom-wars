/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';

vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({
  useGameWallet: () => ({ publicKey: null, sendTransaction: null, connection: null }),
}));

import { AvatarEditor } from './menu';

afterEach(() => vi.restoreAllMocks());

describe('profile avatar editor', () => {
  it('lets the saved-avatar identity card wrap on a narrow phone', () => {
    const source = readFileSync(`${process.cwd()}/src/ui/screens/menu.tsx`, 'utf8');
    const profile = source.slice(
      source.indexOf('export function ProfileScreen'), source.indexOf('// CLANS ('),
    );
    // A custom avatar renders CHANGE + REMOVE beside an allowed 16-character
    // name. Without all three constraints that min-content row exceeds 320px
    // and clips the editor actions instead of wrapping within the profile card.
    expect(profile).toContain("flexWrap: 'wrap'");
    expect(profile).toContain("flex: '1 1 140px', minWidth: 0");
    expect(profile).toContain("overflowWrap: 'anywhere'");
  });

  it('uses the native phone/desktop picker and publishes the selected image', async () => {
    const patchBinary = vi.spyOn(api, 'patchBinary').mockResolvedValue({
      avatarUrl: 'https://cdn.example/avatar/new.webp',
      avatarUpdatedAt: '2026-08-13T12:00:00.000Z',
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<AvatarEditor avatarUrl={null} name="THEODOR" />));

    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('image/jpeg,image/png,image/webp');
    expect(input.hasAttribute('capture')).toBe(false);
    const file = new File(['safe-image'], 'hero.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(patchBinary).toHaveBeenCalledWith('/me/avatar', file);
    expect(host.querySelector<HTMLImageElement>('img[alt="THEODOR avatar"]')?.src)
      .toBe('https://cdn.example/avatar/new.webp');
    expect(host.textContent).toContain('CHANGE');
    expect(host.textContent).toContain('REMOVE');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('AVATAR SAVED');
    expect(Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'CHANGE')
      ?.style.minHeight).toBe('44px');
    await act(async () => root.unmount());
  });

  it('replaces a failed image node when a later upload has a new immutable URL', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(
      <AvatarEditor avatarUrl="https://cdn.example/avatar/bad.webp" name="PLAYER" />,
    ));
    const broken = host.querySelector<HTMLImageElement>('img[alt="PLAYER avatar"]')!;
    broken.dispatchEvent(new Event('error'));
    expect(broken.hidden).toBe(true);

    await act(async () => root.render(
      <AvatarEditor avatarUrl="https://cdn.example/avatar/good.webp" name="PLAYER" />,
    ));
    const recovered = host.querySelector<HTMLImageElement>('img[alt="PLAYER avatar"]')!;
    expect(recovered).not.toBe(broken);
    expect(recovered.hidden).toBe(false);
    await act(async () => root.unmount());
  });

  it('removes only the custom avatar and restores the authored fallback', async () => {
    vi.spyOn(api, 'del').mockResolvedValue({
      avatarUrl: null,
      avatarUpdatedAt: '2026-08-13T12:01:00.000Z',
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(
      <AvatarEditor avatarUrl="https://cdn.example/avatar/old.webp" name="PLAYER" />,
    ));

    const remove = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'REMOVE')!;
    await act(async () => {
      remove.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.del).toHaveBeenCalledWith('/me/avatar');
    expect(host.querySelector('img[alt="PLAYER avatar"]')).toBeNull();
    expect(host.textContent).toContain('UPLOAD');
    await act(async () => root.unmount());
  });
});
