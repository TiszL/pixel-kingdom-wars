import type { BasesDto } from '../../../lib/api';
import { COLORS as C } from '../../primitives';

/** Ownership comes from the complete directory, never the visible map region. */
export function GlobeBaseCounts({ directory, onOpenBases }: {
  directory: Pick<BasesDto, 'bases'> | null;
  onOpenBases(): void;
}): React.JSX.Element {
  const owned = directory?.bases.length;
  const active = directory?.bases.filter((base) => base.status === 'active' && base.slot !== null).length;
  return <button type="button" className="interactive" onClick={onOpenBases}
    aria-label={`Your bases ${owned ?? 'loading'}, ${active ?? 'loading'} active`}
    style={{ minHeight: 44, padding: '5px 10px', border: `2px solid ${C.border}`,
      background: 'rgba(20,18,26,.92)', color: C.goldHi, cursor: 'pointer',
      fontFamily: 'inherit', fontSize: 17, display: 'flex', flexWrap: 'wrap',
      justifyContent: 'center', alignItems: 'center', lineHeight: 1, gap: 6 }}>
    <span>YOUR BASES {owned ?? '—'}</span>
    <span style={{ color: C.textDim }}>· {active ?? '—'} ACTIVE</span>
    <span aria-hidden="true">›</span>
  </button>;
}
