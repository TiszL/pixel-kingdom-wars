import { withPhaseEWebHold } from './webHold';
import { launchBuildingActivity, launchHistoryActivity, requestOrdinaryCraftingPanel, type OrdinaryCraftingPanelOutcome, type OrdinaryCraftingPanelRefusal } from '../../lib/phaseEActivity/access';
import { useUserCommand } from '../pk/useUserCommand';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BUILDINGS_INFO_SOURCE, ORDINARY_CRAFTING_PANEL } from '../../lib/phaseEActivity/panelIds';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseSnapshotGuard, inspectConfiguredBasePanel, isBaseSnapshotGuardCurrent, useApp, type UserCommandHandle, type UserCommandSettlement } from '../../state/store';
import { createOrdinaryCraftingBrowserPorts, ordinaryCraftingIdentity } from '../../lib/ordinaryCrafting/browser';
import { OrdinaryCraftingJournalStore } from '../../lib/ordinaryCrafting/journal';
import { refreshOrdinaryCraftingSnapshot } from '../../lib/ordinaryCrafting/snapshot';
import { PhaseEEntryButton as Btn } from './PhaseEActionDock';

const refusedMessage: Readonly<Record<OrdinaryCraftingPanelRefusal, string>> = {
  source: 'Close the current panel and select the Workshop to try again.',
  scope: 'Your selection changed. Select the Workshop and try again.',
  placing: 'Finish or cancel placement before opening the Workshop.',
  building: 'Workshop access changed. Select a completed Workshop and try again.',
  'web-held': 'Available in the Android app for now.',
  unregistered: 'Workshop panel is not available yet.',
  capability: 'Workshop actions are unavailable right now.',
  'registration-changed': 'The Workshop panel changed. Please try again.',
  'open-refused': "Workshop couldn't open. Please try again.",
};

/** Saved or unreadable history remains reachable even when new refining is unavailable. */
function OrdinaryCraftingDoorEnabled({ discover = false, floating = false, buildingId }: { discover?: boolean; floating?: boolean; buildingId?: string }): React.JSX.Element | null {
  const requestCommand = useUserCommand(() => useApp.getState().authed);
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), epoch = useApp(s => s.baseSelectionEpoch);
  const [found, setFound] = useState<{ wallet: string; baseId: string | null; local: boolean; epoch: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null), [opening, setOpening] = useState(false);
  type Pending = { handle: UserCommandHandle | null; buildingId: string | undefined; discover: boolean };
  const mounted = useRef(false), pending = useRef<Pending | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.wallet !== previous.wallet || state.authed !== previous.authed || state.selectedBaseId !== previous.selectedBaseId
        || state.baseSelectionEpoch !== previous.baseSelectionEpoch || state.screen !== previous.screen
        || state.selectedBuildingId !== previous.selectedBuildingId || state.basePanel !== previous.basePanel) setNotice(null);
    });
    return () => {
      mounted.current = false; unsubscribe();
      const prior = pending.current; pending.current = null; prior?.handle?.();
    };
  }, []);
  useLayoutEffect(() => {
    const prior = pending.current;
    if (prior && (prior.buildingId !== buildingId || prior.discover !== discover)) {
      pending.current = null; prior.handle?.(); setOpening(false);
    }
    setNotice(null);
  }, [buildingId, discover]);
  const run = (start: () => UserCommandHandle, mode: 'panel' | 'legacy' | 'history'): void => {
    if (!mounted.current || pending.current) return;
    const owned: Pending = { handle: null, buildingId, discover };
    pending.current = owned; setOpening(true); setNotice(null);
    const finish = (result: UserCommandSettlement): void => {
      if (!mounted.current || pending.current !== owned) return;
      pending.current = null; setOpening(false);
      if (result.status === 'rejected') setNotice(refusedMessage['open-refused']);
      else if (result.status === 'fulfilled') {
        if (mode === 'panel') {
          const value = result.value as OrdinaryCraftingPanelOutcome;
          if (value?.outcome === 'refused') setNotice(refusedMessage[value.reason]);
        } else if (mode === 'legacy' && result.value === false) setNotice(refusedMessage.building);
      }
      // Dismissal and source-scope cancellation are quiet. Real setPlacing also
      // clears selection/panel, so it cancels instead of reporting a refusal.
    };
    try {
      owned.handle = start(); owned.handle.onSettled(finish);
      // Source retirement can happen synchronously during the admitted command.
      // Cancelling a settled handle never retires the destination's grant.
      if (pending.current !== owned) owned.handle();
    } catch { finish({ status: 'rejected', error: null }); }
  };
  const open = (): void => {
    if (!discover || !buildingId) { run(() => requestCommand(() => launchHistoryActivity('ordinary-crafting')), 'history'); return; }
    const current = useApp.getState();
    const configured = inspectConfiguredBasePanel({ ...ORDINARY_CRAFTING_PANEL, buildingId });
    const panel = current.basePanel;
    const panelSource = panel !== null && (panel.featureId === BUILDINGS_INFO_SOURCE.featureId
      || panel.featureId === ORDINARY_CRAFTING_PANEL.featureId || inspectConfiguredBasePanel(panel).registered);
    if (current.screen !== 'build' && (panelSource || configured.registered)) {
      // The producer owns dismissal and revalidation. Never nest a second
      // command or fall back to the legacy grant after a refused panel attempt.
      run(() => requestOrdinaryCraftingPanel(buildingId), 'panel');
    } else {
      // Preserve the existing unregistered legacy policy owner (P1); only a
      // reviewed panel source/registration opts into the new panel grant path.
      run(() => requestCommand(() => launchBuildingActivity('ordinary-crafting', buildingId)), 'legacy');
    }
  };
  useEffect(() => {
    if (!wallet || !authed) return;
    let active = true; const scope = captureBaseSnapshotGuard(), generation = authCookies.captureGeneration(), identity = ordinaryCraftingIdentity(wallet), store = new OrdinaryCraftingJournalStore(identity);
    const page = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0, actionsEnabled: false };
    const accountCurrent = () => active && authCookies.current(generation) && useApp.getState().authed && useApp.getState().wallet === wallet;
    // Invalidate even an account ABA occurring before React runs effect cleanup.
    const unsubscribe = useApp.subscribe((state, prior) => { if (state.wallet !== prior.wallet || state.authed !== prior.authed) page.active = false; });
    const suspend = () => { page.epoch++; page.visible = false; };
    const resume = () => { page.epoch++; page.visible = document.visibilityState !== 'hidden'; };
    const visibility = () => document.visibilityState === 'hidden' ? suspend() : resume();
    document.addEventListener('visibilitychange', visibility); document.addEventListener('freeze', suspend); document.addEventListener('resume', resume);
    window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume);
    const local = () => { if (accountCurrent() && page.active) setFound({ wallet, baseId: null, local: true, epoch }); };
    void store.read().then(journal => {
      if (journal.operation || journal.archives.length) local();
    }).catch(local).finally(() => store.close().catch(() => undefined));
    if (discover) {
      const ports = createOrdinaryCraftingBrowserPorts({ identity, lifecycle: () => ({ ...page, active: active && page.active }) });
      void refreshOrdinaryCraftingSnapshot(identity, ports).then(snapshot => {
        if (accountCurrent() && page.active && isBaseSnapshotGuardCurrent(scope) && snapshot && (snapshot.enabled || snapshot.view.pendingJobs.length))
          setFound(old => old?.wallet === wallet && old.local ? old : { wallet, baseId, local: false, epoch });
      }).catch(() => undefined);
    }
    // Both closed appearance journals remain local recovery, even without a Workshop.
    void import('../../lib/boundCosmetics/workshopJournal').then(async ({ WorkshopJournalStore }) => {
      if (!accountCurrent() || !page.active) return;
      await Promise.all((['awning', 'wake'] as const).map(async mode => {
        const appearances = new WorkshopJournalStore(identity, globalThis.indexedDB, mode);
        try { const journal = await appearances.read(); if (journal.operation || journal.archives.length) local(); }
        catch { local(); } finally { await appearances.close().catch(() => undefined); }
      }));
    }).catch(local);
    if (discover) void Promise.all([
      import('../../lib/boundCosmetics/workshopBrowser'), import('@shardkeep/shared/boundCosmeticWorkshopApi'),
    ]).then(async ([{ createWorkshopBrowserPorts }, { BoundCosmeticWorkshopViewSchema }]) => {
      if (!accountCurrent() || !page.active || !isBaseSnapshotGuardCurrent(scope)) return;
      const ports = createWorkshopBrowserPorts({ identity, lifecycle: () => ({ ...page, active: active && page.active }) });
      const guard = ports.capture('base', baseId ?? undefined); guard();
      const view = BoundCosmeticWorkshopViewSchema.parse(await ports.view(baseId, guard)); guard();
      if (view.wallet !== wallet || (view.selectedBase?.baseId ?? null) !== baseId) return;
      if (view.recipes.length || view.originals.length)
        setFound(old => old?.wallet === wallet && old.local ? old : { wallet, baseId, local: false, epoch });
    }).catch(() => undefined);
    return () => {
      active = false; page.active = false; unsubscribe();
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('freeze', suspend); document.removeEventListener('resume', resume);
      window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume);
    };
  }, [wallet, authed, baseId, epoch, discover]);
  if (!authed || found?.wallet !== wallet || !found.local && (found.baseId !== baseId || found.epoch !== epoch)) return null;
  return <><Btn variant="sec" disabled={opening} style={{ minHeight: 48, ...(floating ? { position: 'absolute', right: 12, bottom: 'calc(var(--safe-bottom, 0px) + 156px)', zIndex: 20, maxWidth: 'calc(100% - 24px)' } : { width: '100%', marginBottom: 8 }) }}
    onClick={open}>{found.local ? 'WORKSHOP & SAVED RECEIPTS' : 'WORKSHOP'}</Btn>{notice ? <p role="status">{notice}</p> : null}</>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const OrdinaryCraftingDoor = withPhaseEWebHold(OrdinaryCraftingDoorEnabled);
