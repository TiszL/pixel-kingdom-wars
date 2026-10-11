/**
 * <ResourceDrawer> — the web twin of AND:K/ui/hud/ResourceDrawer.kt (DESIGN-SYSTEM §6 "Resource drawer",
 * design/final/drawer.png; owner addenda 1, 2, 3, 6: every resource, SKR included, one tap from the top bar, grouped
 * by where it comes from; every resource is a signpost).
 *
 * A wood frame drops from the top (y 8, ≤ 396 wide; right-anchored on wide screens) over the 40 % scrim, revealing
 * its height in 200 ms `out`, sections fading in with a 20 ms stagger; it closes back up in 140 ms `in`.
 *   1. the info card of the focused row (drawerFocus): 64 art, name + count, purpose + where earned, blue GO with the
 *      destination icon → openFeature(earnedAtFeature) (or the row's own action, e.g. SKR's BID); cross-fades 120 ms;
 *   2. EVERY DAY as 2 × 2 wide rows (value + source; SKR carries BID), then HARVESTERS / WORKSHOP / LODGE as a header
 *      (icon, name, note, GO) over a sideways strip of 48 × 56 tiles; a zero tile is 40 % + red count and still opens
 *      its card; Divine Isle tiles are lavender;
 *   3. the footnote (tint legend).
 * SOL is never here. Every count arrives formatted; blank is "…", never "0".
 *
 * Closes with its X, a tap on the scrim (closeDrawer), and Back: it registers with the app's Back registry
 * (`useMobileBackHandler`, the mechanism P2's sheets and selection use) at DRAWER_BACK_PRIORITY 230 while open.
 * review 90845456 F2 aligns Back with paint order: Seal → drawer 230 → sheets 220 → selection 110.
 * Desktop Esc goes through the host key bridge. A GO does not close it.
 *
 * Pointer rule: the scrim is a hit region only while the drawer is shown; while it animates out it is paint only, so
 * touches reach the kingdom again. Nothing renders while closed. Absolutely positioned: the canvas never reflows.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useMobileBackHandler } from '../../lib/mobileBackGuard';
import { ChunkyFace, HudIcon } from './HudArt';
import { shown, type HomeHudActions, type ResourceDrawerUi, type ResourceGroupUi, type ResourceRowUi } from './hudModel';
import { drawerFocus } from './homeHudLogic';
import { usePkViewportClass } from './pkViewport';
import './ResourceDrawer.css';

export interface ResourceDrawerProps {
  /** The drawer to show, or null when closed (the last one animates out). */
  ui: ResourceDrawerUi | null | undefined;
  on: HomeHudActions;
}

/**
 * Back closes the topmost painted layer (review 90845456 F2). The drawer paints at --z-tray 1100,
 * above sheets at --z-sheet 1050, so it precedes sheet priority 220 while remaining below the Seal.
 * Selection 110 and Scout HUD 120 keep their existing priorities.
 */
export const DRAWER_BACK_PRIORITY = 230;

export function ResourceDrawer({ ui, on }: ResourceDrawerProps): React.JSX.Element | null {
  const vp = usePkViewportClass();
  // Back closes the drawer while it is open (not while it animates out). The registry keeps the latest callback.
  useMobileBackHandler(() => { on.closeDrawer(); }, ui != null, DRAWER_BACK_PRIORITY);
  // Presence (Android kit `Presence`): keep the last drawer while it animates out.
  const [kept, setKept] = useState<ResourceDrawerUi | null>(ui ?? null);
  if (ui && ui !== kept) setKept(ui);
  const leaving = !ui && kept != null;
  const panel = useRef<HTMLElement>(null);

  // If the exit animation cannot run (no CSS, or already finished), unmount on the next frame instead of sticking.
  useEffect(() => {
    if (!leaving) return;
    const id = requestAnimationFrame(() => {
      const el = panel.current;
      if (!el || el.getAnimations().length === 0) setKept(null);
    });
    return () => cancelAnimationFrame(id);
  }, [leaving]);

  if (!kept) return null;
  const drawer = kept;
  const focus = drawerFocus(drawer);
  const title = drawer.title ?? 'RESOURCES';
  const hint = drawer.hint ?? 'tap one to see where';
  const stagger = (i: number): CSSProperties => ({ ['--i' as string]: i }) as CSSProperties;

  return (
    <div className="pk-drawer" data-vp={vp} data-state={leaving ? 'out' : 'in'}>
      <div className={`pk-drawer__scrim${leaving ? '' : ' interactive'}`} aria-hidden="true" onClick={leaving ? undefined : on.closeDrawer} />
      <section ref={panel} className={`pk-drawer__panel${leaving ? '' : ' interactive'}`} role="dialog" aria-modal="true" aria-label={title}
        onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) setKept(null); }}>
        <div className="pk-drawer__wood">
          <div className="pk-drawer__woodin">
            <header className="pk-drawer__head">
              <h2 className="pk-drawer__title pk-disp pk-disp--title pk-ol1">{title}</h2>
              <span className="pk-drawer__hint pk-small">{hint}</span>
              <button type="button" className="pk-tap pk-drawer__close" aria-label="Close resources" onClick={on.closeDrawer} disabled={leaving}>
                <ChunkyFace verb="RED"><HudIcon icon="shape:close" size={24} /></ChunkyFace>
              </button>
            </header>
            <div className="pk-drawer__parch">
              <div className="pk-drawer__scroll">
                <div className="pk-drawer__sec" style={stagger(0)}>
                  {/* Keyed by row: a new focus remounts the card, which cross-fades in (tab-switch 120 ms). */}
                  <InfoCard key={focus?.id ?? ''} row={focus} on={on} />
                </div>
                {drawer.groups.map((group, i) => (
                  <div className="pk-drawer__sec" key={group.id} style={stagger(i + 1)}>
                    <Group group={group} focusId={focus?.id ?? null} on={on} />
                  </div>
                ))}
                {drawer.footnote && (
                  <p className="pk-drawer__foot pk-small pk-drawer__sec" style={stagger(drawer.groups.length + 1)}>{drawer.footnote}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function InfoCard({ row, on }: { row: ResourceRowUi | null; on: HomeHudActions }): React.JSX.Element {
  if (!row) return <p className="pk-drawer__none pk-small">No resources to show yet.</p>;
  const place = row.earnedAtFeature;
  const action = row.action ?? null;
  return (
    <div className="pk-info">
      <span className="pk-info__well"><HudIcon icon={row.icon} size={64} alpha={row.empty ? 0.4 : 1} /></span>
      <div className="pk-info__text">
        <div className="pk-info__line">
          <span className="pk-info__name pk-disp pk-disp--label">{row.name}</span>
          <span className="pk-info__count pk-disp" data-empty={row.empty || undefined}>{shown(row.value)}</span>
        </div>
        <p className="pk-info__body pk-small">{`${row.purpose} ${row.earnedAt}`.trim()}</p>
      </div>
      {place != null ? (
        <button type="button" className="pk-tap pk-info__go" aria-label={`Go to where ${row.name} is earned. ${row.earnedAt}`} onClick={() => on.openFeature(place)}>
          <ChunkyFace verb="BLUE">
            {row.goIcon && <HudIcon icon={row.goIcon} size={32} />}
            <span className="pk-disp pk-ol1">GO</span>
          </ChunkyFace>
        </button>
      ) : action != null ? (
        <button type="button" className="pk-tap pk-info__go" aria-label={`${row.actionLabel ?? 'Go'}: ${row.name}`} onClick={() => on.openFeature(action)}>
          <ChunkyFace verb="BLUE"><span className="pk-disp pk-ol1">{row.actionLabel ?? 'GO'}</span></ChunkyFace>
        </button>
      ) : null}
    </div>
  );
}

function Group({ group, focusId, on }: { group: ResourceGroupUi; focusId: string | null; on: HomeHudActions }): React.JSX.Element {
  const go = group.go;
  return (
    <div className="pk-group">
      <div className="pk-group__head">
        {group.icon.trim() !== '' && <HudIcon icon={group.icon} size={32} />}
        <span className="pk-group__title pk-disp">{group.title}</span>
        <span className="pk-group__note pk-small">{group.note}</span>
        {go != null && <GoSmall label="GO" spoken={`Go to ${group.title.toLowerCase()}`} onClick={() => on.openFeature(go)} />}
      </div>
      {(group.layout ?? 'TILE_STRIP') === 'WIDE_ROWS' ? (
        <div className="pk-wide-grid">
          {group.rows.map((row) => <WideRow key={row.id} row={row} on={on} />)}
        </div>
      ) : group.rows.length === 0 ? (
        <p className="pk-drawer__none pk-small">None yet.</p>
      ) : (
        // Runs to the parchment's right edge so the cut-off tile shows there is more (the peek).
        <div className="pk-strip" role="list">
          {group.rows.map((row) => (
            <button key={row.id} type="button" role="listitem" className="pk-tap pk-tile" data-selected={row.id === focusId || undefined}
              data-empty={row.empty || undefined} data-divine={row.divine || undefined} aria-pressed={row.id === focusId}
              aria-label={`${row.name}, ${shown(row.value)}. ${row.earnedAt}`} onClick={() => on.focusResource(row.id)}>
              <span className="pk-tile__in">
                <HudIcon icon={row.icon} size={32} alpha={row.empty ? 0.4 : 1} className="pk-tile__ic" />
                <span className="pk-tile__n pk-disp">{shown(row.value)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One EVERY DAY row (≥ 50, cream, 2 ink rim): icon, value, source; the row's own action (SKR BID) as a blue button. */
function WideRow({ row, on }: { row: ResourceRowUi; on: HomeHudActions }): React.JSX.Element {
  const action = row.action ?? null;
  return (
    <div className="pk-wide" data-divine={row.divine || undefined}>
      <button type="button" className="pk-tap pk-wide__main" aria-label={`Show ${row.name}: ${shown(row.value)}, ${row.earnedAt}`} onClick={() => on.focusResource(row.id)}>
        <HudIcon icon={row.icon} size={24} alpha={row.empty ? 0.4 : 1} />
        <span className="pk-wide__text">
          <span className="pk-wide__v pk-disp pk-disp--label" data-empty={row.empty || undefined}>{shown(row.value)}</span>
          <span className="pk-wide__n pk-small">{row.earnedAt}</span>
        </span>
      </button>
      {action != null && <GoSmall label={row.actionLabel ?? 'GO'} spoken={`${row.actionLabel ?? 'Go'}: ${row.name}`} onClick={() => on.openFeature(action)} />}
    </div>
  );
}

/** The small blue GO / BID (design .go, 36 tall) inside a ≥ 48 px target. */
function GoSmall({ label, spoken, onClick }: { label: string; spoken: string; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="pk-tap pk-go" aria-label={spoken} onClick={onClick}>
      <span className="pk-go__face"><i /><span className="pk-disp pk-ol1">{label}</span></span>
    </button>
  );
}
