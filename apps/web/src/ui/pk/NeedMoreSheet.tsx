/**
 * <PkNeedMoreSheet>: the generic SHORT sheet (Android AND:K/ui/sheets/buildings/NeedMoreSheet.kt; buildings/SPEC.md
 * R2.2; frame buildings/need-more.png; DS CostPill SHORT). Every SHORT cost pill opens this one sheet: what is missing
 * per resource, where each is made, and one best door. It NEVER spends: every button only navigates (`onDoor`), so
 * there is no gold or green on it, and no outcome copy ("Nothing was spent" never appears here).
 *
 * Mount it inside <PkSheetHost sheet={{ key: 'need-more', size: 'HALF', label: 'Need more' }}>: a HALF sheet, no
 * scrim, closes on an outside tap, ≤ 50 % tall on phones (the blocks scroll inside), a side panel on wide classes.
 * Unknown numbers arrive as "…" and are drawn as such; `stale` shows the 2 px loading line while the doors stay live.
 * Empty `blocks` = the shortfall disappeared: it says so; the host closes the sheet and posts "You have enough now".
 *
 * Built from P0 parts exactly as the Android sheet is (NeedMoreSheet.kt:117-179): Plate WOOD > (title plate + close
 * square) > Plate PARCHMENT (blocksScene false) > blocks + the BLUE PrimaryButton best door; block doors are
 * SecondaryButtons (BLUE + icon, or CHARCOAL + `shape:lock`). Parity verdict B3 (Rule 7: P0 wins).
 */
import { PkCloseSquare, PkPrimaryButton, PkSecondaryButton } from './Button';
import { PkPlate } from './Plate';
import { PkP2Icon } from './p2Kit';
import { blockDoors, haveNeedLine, UNKNOWN } from './p2Logic';
import type { NeedMoreActions, NeedMoreDoorUi, NeedMoreUi, PkViewport, ShortfallUi } from './p2Types';
import { usePkViewport } from './usePkViewport';
import './NeedMoreSheet.css';

export interface PkNeedMoreSheetProps {
  ui: NeedMoreUi;
  on: NeedMoreActions;
  viewport?: PkViewport;
}

export function PkNeedMoreSheet({ ui, on, viewport }: PkNeedMoreSheetProps): React.JSX.Element {
  const live = usePkViewport();
  const vp = viewport ?? live;
  return (
    <div className="pk-needmore" data-pk-vp={vp.vp}>
      <PkPlate kind="WOOD" className="pk-needmore__wood">
        <div className="pk-needmore__head">
          <PkPlate kind="CHARCOAL" className="pk-needmore__title">
            <span className="pk-needmore__titleIn">
              <span className="pk-t-title pk-ol1 pk-needmore__titleText">NEED MORE</span>
              <span className="pk-body pk-needmore__for">{ui.forLabel}</span>
            </span>
          </PkPlate>
          <PkCloseSquare onClick={on.onClose} />
        </div>
        {ui.stale ? <div className="pk-needmore__loading" role="progressbar" aria-label="Updating the numbers" /> : null}
        <PkPlate kind="PARCHMENT" blocksScene={false} className="pk-needmore__parch">
          {ui.blocks.length === 0 ? (
            <p className="pk-body pk-needmore__enough">You have enough now.</p>
          ) : (
            <div className="pk-needmore__blocks">
              {ui.blocks.map((b, i) => (
                <ShortfallBlock key={b.currency} block={b} doors={blockDoors(b.doors, ui.best)} on={on} dpr={vp.dpr} index={i} />
              ))}
            </div>
          )}
          <BestDoor door={ui.best} on={on} />
        </PkPlate>
      </PkPlate>
    </div>
  );
}

function ShortfallBlock({ block, doors, on, dpr, index }: {
  block: ShortfallUi; doors: NeedMoreDoorUi[]; on: NeedMoreActions; dpr: number; index: number;
}): React.JSX.Element {
  const more = block.more.trim() || UNKNOWN;
  const haveNeed = haveNeedLine(block.have, block.need);
  const art = block.icon.startsWith('ui:');
  return (
    <section className="pk-needmore__block" style={{ ['--pk-row-i' as string]: index }}
      aria-label={`${block.name}: need ${more} more. ${haveNeed}. ${block.sourceLine}`}>
      <div className="pk-needmore__blockIn">
        <div className="pk-needmore__row" aria-hidden="true">
          <span className="pk-needmore__well"><PkP2Icon name={block.icon} target={art ? 32 : 36} dpr={dpr} maxCss={36} /></span>
          <span className="pk-needmore__nums">
            <span className="pk-needmore__nameRow">
              <span className="pk-t-label pk-needmore__name">{block.name}</span>
              <span className="pk-t-label pk-needmore__more">{more} more</span>
            </span>
            <span className="pk-small pk-needmore__haveNeed">{haveNeed}</span>
          </span>
        </div>
        <p className="pk-small pk-needmore__source" aria-hidden="true">{block.sourceLine}</p>
        {doors.length > 0 ? (
          <div className="pk-needmore__doors">
            {doors.map((d) => <DoorButton key={d.destination} door={d} on={on} />)}
          </div>
        ) : null}
        {doors.map((d) => (d.locked ? <p key={`l-${d.destination}`} className="pk-small pk-needmore__locked">{d.locked}</p> : null))}
      </div>
    </section>
  );
}

/** A blue door (52 tall: icon + label), or the charcoal padlocked door of a place that is not built yet (Android
 *  DoorButton = SecondaryButton). It always navigates, locked or not: the locked line says why. */
function DoorButton({ door, on }: { door: NeedMoreDoorUi; on: NeedMoreActions }): React.JSX.Element {
  const locked = !!door.locked;
  return (
    <PkSecondaryButton label={door.label} onClick={() => on.onDoor(door.destination)} verb={locked ? 'CHARCOAL' : 'BLUE'}
      icon={locked ? 'shape:lock' : door.icon} contentDescription={[door.label, door.locked ?? door.hint].filter(Boolean).join('. ')} />
  );
}

/** The blue best-door primary (60 tall): icon, label and the live hint (Android BestDoor = PrimaryButton BLUE). */
function BestDoor({ door, on }: { door: NeedMoreDoorUi; on: NeedMoreActions }): React.JSX.Element {
  return <PkPrimaryButton label={door.label} onClick={() => on.onDoor(door.destination)} verb="BLUE" icon={door.icon} sub={door.hint} />;
}
