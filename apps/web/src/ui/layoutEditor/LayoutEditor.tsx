import { supportedPlotVersion } from '../../game/world/basePlot';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, idemKey } from '../../lib/api';
import { bus } from '../../lib/events';
import { useMobileBackHandler } from '../../lib/mobileBackGuard';
import type { BaseStateDto } from '../../state/store';
import { useWindowSize } from '../layout';
import { Btn, COLORS as C, Icon, Sprite } from '../primitives';
import { MobileBackConfirm } from '../MobileBackConfirm';
import { sheetPortrait } from '../sheets';
import { layoutClient, useLayouts } from './api';
import {
  createDraft, LAYOUT_UNDO_LIMIT, markLegacyImported, moveBuilding, moveToTray,
  nudgeSelected, paintWalls, pickUpAll, readLegacyLayout, replaceDraftPositions,
  selectBuilding, slotLabel, undoDraft, validateCompleteLayout, type LayoutDraft,
  type LayoutGeometry,
} from './model';
import type { LayoutClient, LayoutSlot, LayoutsDto } from './types';
import './layoutEditor.css';

export interface LayoutEditorProps {
  baseId: string;
  base: BaseStateDto;
  onClose(): void;
  reloadBase(): Promise<void>;
  client?: LayoutClient;
}

type Drafts = Partial<Record<LayoutSlot, LayoutDraft>>;

export type LayoutEditorMode = 'compact' | 'short-landscape' | 'full';

/** Matches the game HUD's one responsive contract. Short landscape is a
 * mobile rail even when its CSS width is wider than the portrait breakpoint. */
export function layoutEditorMode(vw: number, vh: number): LayoutEditorMode {
  if (vw > vh * 1.1 && vh < 500) return 'short-landscape';
  return vw < 560 ? 'compact' : 'full';
}

const friendlyError = (cause: unknown): string => {
  if (cause instanceof ApiError) {
    const byCode: Record<string, string> = {
      LAYOUT_STALE: 'THIS LAYOUT CHANGED ELSEWHERE — THE SERVER COPY WAS RELOADED',
      LAYOUT_GEOMETRY_STALE: 'BASE GEOMETRY CHANGED — RELOAD BEFORE EDITING',
      LAYOUT_SLOT_LOCKED: `UNLOCK ${slotLabel('FARM')} BEFORE SAVING IT`,
      LAYOUT_INVALID: cause.message.toUpperCase(),
      BASE_BEING_RAIDED: 'AN INCOMING RAID HAS LOCKED THIS BASE',
      INSUFFICIENT_SHARDS: `NOT ENOUGH BASE SHARDS TO UNLOCK ${slotLabel('FARM')}`,
      DEED_OWNERSHIP_CHANGED: 'DEED OWNERSHIP CHANGED — BASE ACCESS CLOSED',
    };
    return (cause.code && byCode[cause.code]) || cause.message.toUpperCase();
  }
  return cause instanceof Error ? cause.message.toUpperCase() : 'LAYOUT ACTION FAILED';
};

const buildingName = (type: string): string => type
  .replace('archertower', 'ARCHER TOWER')
  .replace('electrictower', 'TESLA TOWER')
  .replace('lasertower', 'LASER TOWER')
  .replace('airdefence', 'AIR DEFENCE')
  .replace('goldforge', 'GOLD FORGE')
  .replace('heroaltar', 'VEX ALTAR')
  .replace('siegestool', 'THEODOR STOOL')
  .replace('dragonnest', 'DRAGON NEST')
  .replace('powdermine', 'POWDER MINE')
  .replace('spiketrap', 'SPIKE TRAP')
  .toUpperCase();

function slotDto(data: LayoutsDto, slot: LayoutSlot) {
  return data.slots.find((candidate) => candidate.slot === slot);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

export function LayoutEditor({
  baseId, base, onClose, reloadBase, client = layoutClient,
}: LayoutEditorProps): React.JSX.Element {
  const viewport = useWindowSize();
  const presentation = layoutEditorMode(viewport.w, viewport.h);
  const resource = useLayouts(baseId, client);
  const [slot, setSlot] = useState<LayoutSlot>('HOME');
  const [drafts, setDrafts] = useState<Drafts>({});
  const [busy, setBusy] = useState<'unlock' | 'save' | 'apply' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wallPaintLevel, setWallPaintLevel] = useState<number | null>(null);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [legacyPending, setLegacyPending] = useState<LayoutSlot | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const trayRef = useRef<HTMLElement>(null);
  const baseShapeKey = useMemo(() => base.buildings
    .map((building) => `${building.id}:${building.type}:${building.tx}:${building.ty}`)
    .sort().join('|'), [base.buildings]);
  const priorBaseShape = useRef(baseShapeKey);

  const install = useCallback((data: LayoutsDto, preserve: boolean): void => {
    setDrafts((current) => {
      const next: Drafts = {};
      for (const candidate of data.slots) {
        if (candidate.locked) continue;
        const existing = current[candidate.slot];
        next[candidate.slot] = preserve && existing
          ? existing
          : createDraft(base.buildings, candidate);
      }
      return next;
    });
  }, [base.buildings]);

  useEffect(() => {
    if (!resource.data) return;
    const sameBaseShape = priorBaseShape.current === baseShapeKey;
    priorBaseShape.current = baseShapeKey;
    install(resource.data, sameBaseShape);
    if (!sameBaseShape) setNotice('BASE CHANGED — DRAFTS RELOADED FROM THE LIVE BASE');
  }, [baseShapeKey, install, resource.data]);

  const data = resource.data;
  const currentSlot = data ? slotDto(data, slot) : undefined;
  const draft = drafts[slot];
  const sideOpen = presentation === 'full' || mobileToolsOpen;
  const buildingsById = useMemo(
    () => new Map(base.buildings.map((building) => [building.id, building])),
    [base.buildings],
  );
  const placedIds = useMemo(
    () => new Set(draft?.positions.map((position) => position.buildingId) ?? []),
    [draft?.positions],
  );
  const keepPlaced = base.buildings.some((building) =>
    building.type === 'keep' && placedIds.has(building.id));
  const geometry = useMemo<LayoutGeometry | null>(() => data ? ({
    geometryVersion: data.geometryVersion,
    ...(data.plotVersion !== undefined ? { plotVersion: data.plotVersion } : {}),
    claim: data.claim,
    buildings: base.buildings,
    obstacles: base.obstacles,
  }) : null, [base.buildings, base.obstacles, data]);
  const selected = draft?.selectedId
    ? buildingsById.get(draft.selectedId) ?? null
    : null;
  const selectedInTray = !!selected && !!draft?.trayIds.includes(selected.id);
  const trayedWallGroups = useMemo(() => {
    const groups = new Map<number, string[]>();
    for (const id of draft?.trayIds ?? []) {
      const building = buildingsById.get(id);
      if (building?.type !== 'wall') continue;
      const ids = groups.get(building.level) ?? [];
      ids.push(id);
      groups.set(building.level, ids);
    }
    return groups;
  }, [buildingsById, draft?.trayIds]);

  const updateDraft = useCallback((fn: (current: LayoutDraft) => LayoutDraft): void => {
    setDrafts((current) => {
      const active = current[slot];
      return active ? { ...current, [slot]: fn(active) } : current;
    });
  }, [slot]);

  const applyResult = useCallback((result: { draft: LayoutDraft; error: string | null }): void => {
    if (result.error) setNotice(result.error);
    setDrafts((current) => current[slot]
      ? { ...current, [slot]: result.draft }
      : current);
  }, [slot]);

  // The canvas owns the real art and footprints. React sends only a reversible
  // coordinate draft; BaseScene never posts an ordinary move while it is shown.
  useEffect(() => {
    if (!draft || !data) {
      bus.emit('base:layoutDraft', { op: 'hide' });
      return;
    }
    bus.emit('base:layoutDraft', {
      op: 'show',
      geometryVersion: data.geometryVersion,
      positions: draft.positions,
      trayIds: draft.trayIds,
      selectedBuildingId: draft.selectedId,
      wallPaintLevel,
    });
  }, [data, draft, wallPaintLevel]);

  useEffect(() => {
    if (wallPaintLevel !== null && !trayedWallGroups.has(wallPaintLevel)) setWallPaintLevel(null);
  }, [trayedWallGroups, wallPaintLevel]);

  useEffect(() => () => {
    bus.emit('base:layoutDraft', { op: 'hide' });
    bus.emit('base:insets', { top: 0, bottom: 0, left: 0, right: 0 });
  }, []);

  useEffect(() => bus.on('base:layoutEdit', (edit) => {
    if (!geometry) return;
    setNotice(null);
    if (edit.kind === 'select') {
      updateDraft((current) => selectBuilding(current, edit.buildingId));
      return;
    }
    if (edit.kind === 'move') {
      const active = drafts[slot];
      if (active) applyResult(moveBuilding(active, geometry, edit.buildingId, edit.tx, edit.ty));
      return;
    }
    const active = drafts[slot];
    if (active) applyResult(paintWalls(active, geometry, edit.level, edit.tiles));
  }), [applyResult, drafts, geometry, slot, updateDraft]);

  // Measure only the interactive chrome; the rest of the full-screen editor is
  // pointer-transparent and remains available for pan, pinch, wheel and drag.
  useEffect(() => {
    const emit = (): void => {
      const head = headRef.current?.getBoundingClientRect();
      const side = sideRef.current?.getBoundingClientRect();
      const tray = trayRef.current?.getBoundingClientRect();
      const bottomTop = presentation === 'compact' && side
        ? side.top
        : tray?.top ?? window.innerHeight;
      bus.emit('base:insets', {
        top: Math.ceil(head?.bottom ?? head?.height ?? 0),
        bottom: Math.ceil(Math.max(0, window.innerHeight - bottomTop)),
        left: Math.ceil(presentation === 'compact' ? 0 : side?.right ?? 0),
        right: 0,
      });
    };
    emit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(emit);
    if (observer) {
      if (headRef.current) observer.observe(headRef.current);
      if (sideRef.current) observer.observe(sideRef.current);
      if (trayRef.current) observer.observe(trayRef.current);
    }
    window.addEventListener('resize', emit);
    return () => { observer?.disconnect(); window.removeEventListener('resize', emit); };
  }, [data, draft?.trayIds.length, presentation, sideOpen]);

  const close = useCallback((): void => {
    if (busy) return;
    bus.emit('base:layoutDraft', { op: 'hide' });
    onClose();
  }, [busy, onClose]);

  useMobileBackHandler(() => {
    if (busy) return true;
    if (draft?.dirty) {
      setDiscardOpen(true);
      return true;
    }
    close();
    return true;
  }, true, 160);

  const nudge = useCallback((dx: number, dy: number): void => {
    if (!draft || !geometry) return;
    setNotice(null);
    applyResult(nudgeSelected(draft, geometry, dx, dy));
  }, [applyResult, draft, geometry]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target) || busy) return;
      const delta = event.key === 'ArrowUp' ? [0, -1]
        : event.key === 'ArrowDown' ? [0, 1]
          : event.key === 'ArrowLeft' ? [-1, 0]
            : event.key === 'ArrowRight' ? [1, 0] : null;
      if (delta) {
        event.preventDefault();
        nudge(delta[0]!, delta[1]!);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && draft?.selectedId) {
        event.preventDefault();
        applyResult(moveToTray(draft, base.buildings, draft.selectedId));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyResult, base.buildings, busy, close, draft, nudge]);

  const unlockFarm = async (): Promise<void> => {
    if (!data || busy || !supportedPlotVersion(data.plotVersion)) return;
    setBusy('unlock');
    setNotice(null);
    try {
      const result = await client.unlockFarm(baseId, idemKey());
      await reloadBase();
      const next = await resource.reload();
      if (next) install(next, true);
      setNotice(result.chargedShards === '0'
        ? `${slotLabel('FARM')} WAS ALREADY UNLOCKED`
        : `${slotLabel('FARM')} UNLOCKED · ${result.chargedShards} SHARDS`);
    } catch (cause) {
      setNotice(friendlyError(cause));
    } finally {
      setBusy(null);
    }
  };

  const persist = async (mode: 'save' | 'save_apply'): Promise<void> => {
    if (!data || !currentSlot || !draft || !geometry || busy) return;
    if (!keepPlaced) {
      setNotice('PLACE THE KEEP BEFORE SAVING');
      return;
    }
    if (draft.trayIds.length > 0) {
      setNotice('PLACE EVERY TRAYED BUILDING BEFORE SAVING');
      return;
    }
    const invalid = validateCompleteLayout(geometry, draft.positions);
    if (invalid) { setNotice(invalid); return; }
    setBusy(mode === 'save' ? 'save' : 'apply');
    setNotice(null);
    try {
      const result = await client.save(baseId, slot, {
        geometryVersion: data.geometryVersion,
        ...(data.plotVersion !== undefined ? { plotVersion: data.plotVersion } : {}),
        mode,
        expectedSlotEtag: currentSlot.etag,
        ...(mode === 'save_apply' ? { expectedActiveEtag: data.active.etag } : {}),
        positions: draft.positions,
      });
      await reloadBase();
      const next = await resource.reload();
      if (next) install(next, false);
      if (legacyPending === slot && typeof localStorage !== 'undefined') {
        markLegacyImported(localStorage, baseId, slot);
        setLegacyPending(null);
      }
      bus.emit('base:refresh', undefined);
      setNotice(mode === 'save_apply'
        ? `${slot} APPLIED · ${result.moved} MOVED${result.replayed ? ' · REPLAY SAFE' : ''}`
        : `${slot} SAVED${result.replayed ? ' · ALREADY CURRENT' : ''}`);
    } catch (cause) {
      setNotice(friendlyError(cause));
      if (cause instanceof ApiError && (cause.code === 'LAYOUT_STALE'
        || cause.code === 'LAYOUT_GEOMETRY_STALE')) {
        const next = await resource.reload();
        if (next) install(next, false);
      }
    } finally {
      setBusy(null);
    }
  };

  const legacy = useMemo(() => {
    if (typeof localStorage === 'undefined') return null;
    return readLegacyLayout(localStorage, baseId, slot, base.buildings);
  }, [base.buildings, baseId, slot]);

  const importLegacy = (): void => {
    if (!legacy || !draft || !geometry) return;
    const invalid = validateCompleteLayout(geometry, legacy);
    if (invalid) { setNotice(`DEVICE PRESET REFUSED · ${invalid}`); return; }
    updateDraft((current) => replaceDraftPositions(current, legacy));
    setLegacyPending(slot);
    setNotice(`DEVICE SLOT ${slot === 'HOME' ? 'A' : 'B'} IMPORTED INTO THIS DRAFT`);
  };

  if (!data || resource.loading && !draft) {
    return (
      <div className="layout-editor layout-editor-state interactive" role="status">
        <span>{resource.error ? friendlyError(resource.error) : 'Loading your layouts…'}</span>
        {resource.error && <Btn onClick={() => { void resource.reload(); }}>RETRY</Btn>}
        <Btn variant="ghost" onClick={close}>CANCEL</Btn>
      </div>
    );
  }

  if (!supportedPlotVersion(data.plotVersion) || !supportedPlotVersion(base.plotVersion)) {
    return <div className="layout-editor layout-editor-state interactive">
      Update the game to edit this base.<Btn variant="ghost" onClick={close}>CLOSE</Btn>
    </div>;
  }

  if (!currentSlot) {
    return <div className="layout-editor layout-editor-state interactive">LAYOUT SLOT UNAVAILABLE</div>;
  }

  const locked = currentSlot.locked;
  const saveDisabled = locked || !draft || !keepPlaced
    || draft.trayIds.length > 0 || busy !== null;

  return (
    <div className="layout-editor" ref={rootRef} data-layout-editor="true"
      data-layout-mode={presentation} data-tools-open={sideOpen ? 'true' : 'false'}>
      <header ref={headRef} className="layout-editor-head interactive">
        <div className="layout-editor-title">
          <Icon name="layout" size={24} />
          <span>LAYOUTS</span>
          <small>GEOMETRY V{data.geometryVersion} · {data.claim.size}×{data.claim.size} CLAIM</small>
        </div>
        <nav aria-label="Layout slots" className="layout-editor-slots">
          {(['HOME', 'FARM'] as const).map((candidate) => {
            const row = slotDto(data, candidate);
            return (
              <button key={candidate} type="button" className={candidate === slot ? 'is-active' : ''}
                aria-pressed={candidate === slot}
                onClick={() => {
                  setSlot(candidate);
                  setWallPaintLevel(null);
                  setNotice(null);
                  if (presentation !== 'full' && row?.locked) setMobileToolsOpen(true);
                }}>
                {slotLabel(candidate)}{row?.locked ? ' · LOCKED' : data.active.slot === candidate ? ' · ACTIVE' : ''}
              </button>
            );
          })}
        </nav>
        <button type="button" className="layout-editor-icon" aria-label="Fit base"
                onClick={() => bus.emit('base:camera', { op: 'fit' })}><Icon name="locate" size={22} /></button>
        <button type="button" className="layout-editor-icon" aria-label="Cancel layout editing"
          disabled={busy !== null} onClick={close}><Icon name="close" size={22} /></button>
      </header>

      <aside ref={sideRef} id="layout-editor-tools" className="layout-editor-side interactive">
        <button type="button" className="layout-editor-side-toggle"
          aria-expanded={sideOpen} aria-controls="layout-editor-tools-content"
          aria-label={sideOpen ? 'Close layout tools' : 'Open layout tools'}
          onClick={() => setMobileToolsOpen((open) => !open)}>
          <Icon name="settings" size={20} />
          <span className="layout-editor-side-toggle-text">
            {locked ? `${slotLabel('FARM')} LOCKED` : selected ? buildingName(selected.type) : 'LAYOUT TOOLS'}
          </span>
          <span className="layout-editor-side-toggle-state" aria-hidden="true">{sideOpen ? '▾' : '▴'}</span>
        </button>
        <div id="layout-editor-tools-content" className="layout-editor-side-content">
          {locked ? (
            <section className="layout-editor-lock">
              <strong>{slotLabel('FARM')} SLOT LOCKED</strong>
              <p>UNLOCKS A SECOND SERVER-STORED POSITION SET FOR THIS DEED.</p>
              <Btn disabled={busy !== null} onClick={() => { void unlockFarm(); }}>
                {busy === 'unlock' ? 'UNLOCKING…' : `UNLOCK · ${data.farmUnlock.costShards} SHARDS`}
              </Btn>
            </section>
          ) : (
            <>
              <section className="layout-editor-status">
                <strong>{slotLabel(slot)}</strong>
                <span>{currentSlot.compatibility === 'needs_repair' ? 'REPAIR COPY LOADED FROM LIVE BASE'
                  : currentSlot.compatibility === 'empty' ? 'NEW COPY LOADED FROM LIVE BASE'
                    : data.active.slot === slot ? 'ACTIVE ON THE BASE' : 'SAVED SERVER PRESET'}</span>
                <span>{draft?.positions.length ?? 0} PLACED · {draft?.trayIds.length ?? 0} IN TRAY</span>
                {!keepPlaced && <span className="layout-editor-keep-required">KEEP REQUIRED · PLACE IT BEFORE SAVING</span>}
              </section>

              {selected && draft && (
                <section className="layout-editor-selected" aria-live="polite">
                  <strong>{buildingName(selected.type)} · L{selected.level}</strong>
                  <span>{selected.id.slice(0, 8)} · {selectedInTray ? 'IN TRAY' : 'ON PLOT'}</span>
                  {!selectedInTray && (
                    <div className="layout-editor-nudge" aria-label="Nudge selected building">
                      <button type="button" aria-label="Nudge up" onClick={() => nudge(0, -1)}>↑</button>
                      <button type="button" aria-label="Nudge left" onClick={() => nudge(-1, 0)}>←</button>
                      <button type="button" aria-label="Nudge down" onClick={() => nudge(0, 1)}>↓</button>
                      <button type="button" aria-label="Nudge right" onClick={() => nudge(1, 0)}>→</button>
                    </div>
                  )}
                  <Btn variant="sec" disabled={selectedInTray}
                    onClick={() => applyResult(moveToTray(draft, base.buildings, selected.id))}>
                    MOVE TO TRAY
                  </Btn>
                </section>
              )}

              <section className="layout-editor-tools">
                <Btn variant="sec" disabled={!draft || draft.history.length === 0 || busy !== null}
                  onClick={() => updateDraft(undoDraft)}>UNDO · {draft?.history.length ?? 0}/{LAYOUT_UNDO_LIMIT}</Btn>
                <Btn variant="ghost" disabled={!draft || busy !== null}
                  onClick={() => updateDraft((current) => pickUpAll(current, base.buildings))}>PICK UP ALL</Btn>
                {wallPaintLevel !== null && (
                  <Btn variant="gold" disabled={busy !== null}
                    onClick={() => setWallPaintLevel(null)}>
                    PAINTING LEVEL {wallPaintLevel} WALLS
                  </Btn>
                )}
              </section>

              {legacy && (
                <button type="button" className="layout-editor-import" onClick={importLegacy}>
                  IMPORT DEVICE SLOT {slot === 'HOME' ? 'A' : 'B'} · EXACT IDS
                </button>
              )}

              <details className="layout-editor-help">
                <summary>HOW TO EDIT</summary>
                <p>HOLD THEN DRAG A BUILDING. DRAG EMPTY GROUND TO PAN; PINCH OR WHEEL TO ZOOM.</p>
                <p>SELECT A TRAY ITEM, THEN TAP ITS NEW TILE. ARROW KEYS OR THE PAD NUDGE ONE TILE.</p>
                <p>WALL PAINT USES EXISTING TRAYED WALLS IN ORDER. PICK UP ALL INCLUDES THE KEEP.</p>
                <p>CANCEL SENDS NOTHING. SAVE REQUIRES EVERY BUILDING AND EXACTLY ONE KEEP ON THE PLOT.</p>
              </details>
            </>
          )}
        </div>
      </aside>

      {!locked && draft && (
        <footer ref={trayRef} className="layout-editor-footer interactive">
          <div className="layout-editor-tray" aria-label="Unplaced buildings">
            <strong>TRAY</strong>
            {draft.trayIds.length === 0 ? <span>EMPTY · EVERY BUILDING IS PLACED</span>
              : draft.trayIds.map((id) => {
                const building = buildingsById.get(id);
                if (!building) return null;
                if (building.type === 'wall') {
                  const ids = trayedWallGroups.get(building.level) ?? [];
                  if (ids[0] !== id) return null;
                  return (
                    <button key={`walls-${building.level}`} type="button"
                      data-layout-wall-level={building.level}
                      aria-label={`${ids.length} walls, level ${building.level}`}
                      className={wallPaintLevel === building.level ? 'is-selected' : ''}
                      onClick={() => {
                        setWallPaintLevel((active) => active === building.level ? null : building.level);
                        updateDraft((current) => selectBuilding(current, id));
                      }}>
                      <Sprite name={sheetPortrait('wall', building.level)} w={40} h={40} />
                      <span>WALLS ×{ids.length}</span>
                      <small>LEVEL {building.level}</small>
                    </button>
                  );
                }
                const heroLevel = building.type === 'heroaltar'
                  ? base.heroes?.find((hero) => hero.hero === 'vex')?.level
                  : building.type === 'siegestool'
                    ? base.heroes?.find((hero) => hero.hero === 'theodor')?.level
                    : undefined;
                return (
                  <button key={id} type="button" data-layout-tray-id={id}
                    aria-label={`${buildingName(building.type)}, level ${building.level}, ${id.slice(0, 8)}`}
                    className={draft.selectedId === id ? 'is-selected' : ''}
                    onClick={() => {
                      setWallPaintLevel(null);
                      updateDraft((current) => selectBuilding(current, id));
                    }}>
                    <Sprite name={sheetPortrait(building.type, building.level, heroLevel)} w={40} h={40} />
                    <span>{buildingName(building.type)}</span>
                    <small>LEVEL {building.level}</small>
                  </button>
                );
              })}
          </div>
          <div className="layout-editor-actions">
            <Btn variant="ghost" disabled={busy !== null} onClick={close}>CANCEL</Btn>
            <Btn variant="sec" disabled={saveDisabled} onClick={() => { void persist('save'); }}>
              {busy === 'save' ? 'SAVING…' : 'SAVE'}
            </Btn>
            <Btn disabled={saveDisabled} onClick={() => { void persist('save_apply'); }}>
              {busy === 'apply' ? 'APPLYING…' : 'SAVE & APPLY'}
            </Btn>
          </div>
        </footer>
      )}

      {notice && <div className="layout-editor-notice interactive" role="status"
        style={{ borderColor: notice.includes('FAILED') || notice.includes('BLOCK') ? C.danger : C.gold }}>
        {notice}
      </div>}
      {discardOpen && (
        <MobileBackConfirm title="DISCARD LAYOUT?"
          body="Your unsaved layout changes will be lost. The saved server layout will stay unchanged."
          confirmLabel="DISCARD" onCancel={() => setDiscardOpen(false)}
          onConfirm={() => { setDiscardOpen(false); close(); }} />
      )}
    </div>
  );
}
