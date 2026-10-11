import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { InventoryHudButton } from './InventoryHudButton';

describe('inventory HUD affordance', () => {
  it('is a named button with distinct visible inventory copy', () => {
    const html = renderToStaticMarkup(<InventoryHudButton onOpen={vi.fn()} />);
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Open inventory"');
    expect(html).toContain('INVENTORY');
    expect(html).toContain('<img');
    expect(html).toContain('legacy-ui_icon_backpack');
    expect(html).not.toContain('ui_icon_layout');
    expect(html).toContain('min-width:44px');
    expect(html).toContain('min-height:44px');
  });
});
