/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { PhaseERegistration } from './PhaseERegistration';
import { requestUserCommand, useApp } from '../../state/store';
import { createPanelSession, type PanelDismissRequest } from '../pk/panelSession';
vi.mock('./PhaseEActionDock', () => ({ PhaseEActionDock: ({ children }: { children: ReactNode }) => <div>{children}</div>, PhaseEActionGroup: ({ group, children }: { group: string; children: ReactNode }) => group === 'islands' ? <div>{children}</div> : null,
  PhaseEEntryButton: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => <button data-optional="false" onClick={onClick}>{children}</button> }));
// Real Trial entry + registration; only the existing lazy screen body is a probe.
vi.mock('./DivineTrialScreen', () => ({ DivineTrialScreen: () => <span data-original-trial-screen /> }));
vi.mock('./DivineFragmentsEntry', () => ({ DivineFragmentsEntry: ({ onOpen }: { onOpen?: () => void }) => <button data-optional={String(!!onOpen)} onClick={onOpen}>FRAGMENTS</button> }));
vi.mock('./MiningTaxClaimsEntry', () => ({ MiningTaxClaimsEntry: () => null }));
vi.mock('./SeekerResourceClaimsEntry', () => ({ SeekerResourceClaimsEntry: () => null }));
vi.mock('./SeekerShardsClaimsEntry', () => ({ SeekerShardsClaimsEntry: () => null }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, prior: ReturnType<typeof useApp.getState>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); prior = useApp.getState(); useApp.setState({ screen: 'base', wallet: 'trial-wallet', authed: true, basePanel: null }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState(prior, true); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each([['DIVINE TRIALS', 'map.divineTrials'], ['FRAGMENTS', 'map.divineFragments']] as const)('keeps Trials in place and forwards only Fragments: %s (188719c1)', async (label, id) => {
  let destination: string | null = null; const pending: PanelDismissRequest[] = [];
  const panel = { kind: 'hub' as const, featureId: 'hub.draft' };
  const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel,
    canMutate: () => false, canRecover: () => false });
  const off = session.mount(); session.setDismissPolicy(request => { pending.push(request); });
  if (id === 'map.divineTrials') useApp.setState({ basePanel: panel });
  const onOpen = vi.fn((featureId: string) => { requestUserCommand(() => { destination = featureId; useApp.getState().setScreen('map'); }); });
  try {
  await act(async () => root.render(<PhaseERegistration screen="base" inBase authed actionsEnabled={false} onOpenMapFeature={onOpen} />));
  await vi.waitFor(() => expect(host.querySelectorAll('button')).toHaveLength(2));
  await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === label)!.click(); });
  if (id === 'map.divineTrials') {
    await vi.waitFor(() => expect(host.querySelector('[data-original-trial-screen]')).not.toBeNull());
    expect(host.textContent).not.toContain('Opening trial history…');
    expect(onOpen).not.toHaveBeenCalled(); expect(pending).toHaveLength(0); expect(destination).toBeNull();
    expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().basePanel).toBe(panel);
  } else {
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(id); expect(destination).toBe(id);
    expect(useApp.getState().screen).toBe('map'); expect(pending).toHaveLength(0);
  }
  } finally { off(); }
});
it('leaves both original entry callbacks absent when no producer is provided', async () => {
  await act(async () => root.render(<PhaseERegistration screen="base" inBase authed actionsEnabled />));
  await vi.waitFor(() => expect(host.querySelectorAll('button')).toHaveLength(2));
  expect([...host.querySelectorAll('button')].every(b => b.dataset.optional === 'false')).toBe(true);
});
