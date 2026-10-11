/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import BuildingInfo from './BuildingInfo';
import { CODEX } from './screens/codex';
import { sprite } from './icons';

// The selected-level portrait uses the real sheets resolver; wallet adapters
// behind its purchase hook are unrelated to rendering this information card.
vi.mock('../auth/useSolPurchase', () => ({ useSolPurchase: vi.fn() }));

function portrait(type: string, level: number): HTMLImageElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<BuildingInfo type={type} level={level} maxLevel={20} />);
  const image = host.querySelector('img');
  if (!image) throw new Error(`Missing ${type} information portrait`);
  return image;
}

describe('selected wall information portrait', () => {
  it.each([[1, 1], [5, 2], [9, 3], [16, 4], [17, 5], [20, 5]])(
    'shows the selected level %i wall as T%i instead of the generic timber entry', (level, tier) => {
      expect(portrait('wall', level!).getAttribute('src'))
        .toContain(`/art/source/walls-five-tier/family/t${tier}/pieces/straight.png`);
    },
  );

  it('preserves the generic Codex wall icon and other building information art', () => {
    const wall = CODEX.DEFENSE.find(entry => entry.name === 'WALLS')!;
    const cannon = CODEX.DEFENSE.find(entry => entry.name === 'CANNON')!;
    expect(wall.img).toBe('wall5_t1_straight_intact_f1');
    expect(portrait('cannon', 17).getAttribute('src')).toBe(sprite(cannon.img));
  });
});
