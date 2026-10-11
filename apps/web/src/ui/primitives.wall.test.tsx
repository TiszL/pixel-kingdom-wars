/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Sprite } from './primitives';

function image(name: string): HTMLImageElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<Sprite name={name} w={28} h={28} />);
  const element = host.querySelector('img');
  if (!element) throw new Error(`Missing sprite ${name}`);
  return element;
}

describe('rectangular wall art in square UI slots', () => {
  it('preserves each tier silhouette without stretching its 32px-wide source frame', () => {
    for (let tier = 1; tier <= 5; tier++) {
      const portrait = image(`wall5_t${tier}_straight_intact_f1`);
      expect(portrait.style.objectFit).toBe('contain');
      expect(portrait.width).toBe(28);
      expect(portrait.height).toBe(28);
      expect(portrait.style.imageRendering).toBe('pixelated');
    }
  });

  it('leaves existing non-wall sprite fitting unchanged', () => {
    expect(image('brand_token_logo').style.objectFit).toBe('');
    expect(image('ui_portrait_cannon_t4').style.objectFit).toBe('');
  });
});
