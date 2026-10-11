import type { CSSProperties, ReactNode } from 'react';
import { useDevicePixelRatio } from '../pkViewport';
import { GRASS_COLORS, GRASS_PERIOD_CELLS, GRASS_TILE_BACKGROUND, grassCellCssSize } from './grassWellLogic';
import './GrassWell.css';

export interface GrassWellProps {
  children?: ReactNode;
  goldRim?: boolean;
  className?: string;
}

/**
 * Native drawGrassWell as a decorative, parent-sized box. The caller supplies geometry, content layout and art.
 * Direct children stay direct children. The S corners clip the whole well; badges outside its bounds belong beside it.
 */
export default function GrassWell({ children, goldRim = false, className }: GrassWellProps): React.JSX.Element {
  const dpr = useDevicePixelRatio();
  const style = {
    '--pk-grass-image': GRASS_TILE_BACKGROUND,
    '--pk-grass-tile-size': `${GRASS_PERIOD_CELLS * grassCellCssSize(dpr)}px`,
    '--pk-grass-band': GRASS_COLORS.band,
  } as CSSProperties;
  return (
    <div className={['pk-grass-well', className].filter(Boolean).join(' ')} data-gold-rim={goldRim} style={style}>
      {children}
    </div>
  );
}
