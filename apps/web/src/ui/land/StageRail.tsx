/** Keep payment confirmation and asynchronous minting distinct on every viewport. */
import { COLORS as C } from '../primitives';
import { LAND_STAGES, type LandStage } from './landFlow';

export function StageRail({ stage }: { stage: LandStage }): React.JSX.Element {
  const at = LAND_STAGES.findIndex((s) => s.id === stage);
  return (
    <ol aria-label="Land purchase stages" style={{
      listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px 6px', minWidth: 0,
    }}>
      {LAND_STAGES.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'active' : 'next';
        const ink = state === 'active' ? C.goldHi : state === 'done' ? C.gold : C.textFaint;
        const last = i === LAND_STAGES.length - 1;
        return (
          <li key={s.id} data-stage={s.id} data-state={state}
            {...(state === 'active' ? { 'aria-current': 'step' as const } : {})}
            style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: last ? '0 0 auto' : '1 1 0' }}>
            <span aria-hidden="true" style={{
              width: 10, height: 10, flex: 'none', boxSizing: 'border-box',
              background: state === 'next' ? 'transparent' : C.gold,
              border: `2px solid ${state === 'next' ? C.borderLt : C.goldHi}`,
              boxShadow: state === 'active' ? `0 0 0 2px ${C.ink}, 0 0 8px ${C.goldHi}` : 'none',
            }} />
            <span style={{
              color: ink, fontSize: 12, letterSpacing: '.5px', lineHeight: 1.2,
              textShadow: state === 'active' ? `0 0 6px ${C.gold}` : 'none',
            }}>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
