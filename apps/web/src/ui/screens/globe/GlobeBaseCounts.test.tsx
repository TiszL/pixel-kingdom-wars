/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { WalletBaseDto } from '../../../lib/api';
import { GlobeBaseCounts } from './GlobeBaseCounts';

it('keeps all owned bases distinct from active slots and the visible world count', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); const root = createRoot(host);
  const open = vi.fn();
  const directory = { bases: [
    { id: 'free', status: 'active', slot: 1 },
    { id: 'paid', status: 'active', slot: 2 },
    { id: 'inactive', status: 'inactive', slot: null },
    { id: 'unallocated', status: 'active', slot: null },
  ] as WalletBaseDto[] };
  try {
    await act(async () => root.render(<GlobeBaseCounts directory={directory} onOpenBases={open} />));
    expect(host.textContent).toContain('YOUR BASES 4');
    expect(host.textContent).toContain('2 ACTIVE');
    await act(async () => host.querySelector('button')!.click());
    expect(open).toHaveBeenCalledOnce();
    await act(async () => root.render(<GlobeBaseCounts directory={{ bases: [...directory.bases] }} onOpenBases={open} />));
    expect(host.textContent).toContain('YOUR BASES 4');
    await act(async () => root.render(<GlobeBaseCounts directory={null} onOpenBases={open} />));
    expect(host.textContent).toContain('YOUR BASES —');
    expect(host.textContent).not.toContain('0 ACTIVE');
  } finally { await act(async () => root.unmount()); }
});
