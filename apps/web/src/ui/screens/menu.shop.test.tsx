/** @vitest-environment happy-dom */
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ShopCatalogView, type ShopItemsDto } from './shopCatalog';

/** Mirrors the post-2026-08-16 catalog shape: gear is forge-drop-exclusive
 * (owner verbatim: "gear also should be gathered exclusively from drops"), so
 * every gear entry carries acquisition 'drop' and costKeep 0 — only
 * consumables (legacy items, writs, hero contracts) remain purchasable. */
function fixture(): ShopItemsDto {
  return {
    catalog: [
      {
        id: 'wardens_helm', name: "WARDEN'S HELM", kind: 'gear', slot: 'helm',
        rarity: 'rare', weight: 4, costKeep: 0, asset: 'itm_helm',
        desc: 'A forge-dropped helm.', acquisition: { type: 'drop' },
        maxOwned: 2,
      },
      {
        id: 'keg_of_haste', name: 'KEG OF HASTE', kind: 'consumable', rarity: 'common',
        weight: 1, costKeep: 60, asset: 'ui_icon_swiftboots', desc: 'A shop consumable.',
        acquisition: { type: 'shop' }, maxOwned: null,
      },
      {
        // An OWNED drop-gear piece (bought under the retired rules or won from
        // the forge): ownership is honoured in Inventory, but the Shop must
        // still never list it for sale.
        id: 'banner_of_nine', name: 'BANNER OF THE NINE', kind: 'gear', slot: 'banner',
        rarity: 'mythic', weight: 5, costKeep: 0, asset: 'itm_banner',
        desc: 'An owned forge-dropped banner.',
        acquisition: { type: 'drop' }, maxOwned: 1,
      },
      {
        id: 'warzone_aegis', name: 'WARZONE AEGIS', kind: 'consumable', rarity: 'legendary',
        weight: 3, costKeep: 8_000, asset: 'ui_icon_shield', desc: 'Earned only.',
        acquisition: { type: 'drop' }, maxOwned: null, dropOnly: true,
      },
    ],
    owned: [{ itemId: 'banner_of_nine', qty: 1 }],
  };
}

describe('Shop catalog ownership boundary', () => {
  it.each([0, 1])('never offers crafted materials as system purchases, including owned stock (%i)', (qty) => {
    // Craft visibility is needed for recovery during a pause, not admission to BUY.
    const data = fixture();
    data.catalog.push({ ...data.catalog[1]!, id: 'forge_ingot', name: 'FORGE INGOT',
      kind: 'material', costKeep: 0, acquisition: { type: 'craft' } });
    if (qty) data.owned.push({ itemId: 'forge_ingot', qty });
    const html = renderToStaticMarkup(<ShopCatalogView
      data={data} busyId={null} kind="all" onKind={vi.fn()} onBuy={vi.fn()}
    />);
    expect(html).not.toContain('FORGE INGOT');
    expect(html).toContain('KEG OF HASTE');
  });

  it('never sells drops — gear vanished from the shop when it went forge-drop-exclusive', () => {
    // WHY: buyItem refuses acquisition 'drop' server-side; a shop card for
    // gear would be a dead BUY button advertising a retired purchase path.
    const html = renderToStaticMarkup(<ShopCatalogView
      data={fixture()} busyId={null} kind="all" onKind={vi.fn()} onBuy={vi.fn()}
    />);
    expect(html).not.toContain("WARDEN&#x27;S HELM");
    expect(html).not.toContain('BANNER OF THE NINE'); // owned gear: honoured in Inventory, still not FOR SALE
    expect(html).not.toContain('WARZONE AEGIS');
    expect(html).toContain('KEG OF HASTE');
    expect(html).toContain('BUY · 60');
    expect(html).not.toMatch(/>USE<|>EQUIP</);
  });

  it('hides the category tab row when only consumables remain, and sells at touch geometry', async () => {
    // With gear unpurchasable the GEAR tab would be an empty aisle — a
    // single-kind catalog renders no tablist at all.
    const buy = vi.fn();
    function Harness(): React.JSX.Element {
      const [kind, setKind] = useState<'all' | 'gear' | 'consumable'>('all');
      return <ShopCatalogView data={fixture()} busyId={null} kind={kind} onKind={setKind} onBuy={buy} />;
    }
    const host = document.createElement('div');
    host.style.width = '390px';
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));

    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons.find((button) => button.textContent === 'GEAR')).toBeUndefined();
    expect(host.querySelector('[role="tablist"]')).toBeNull();

    const buyKeg = buttons.find((button) => button.textContent?.includes('BUY · 60'));
    expect(buyKeg?.getAttribute('style')).toContain('min-height: 44px');
    await act(async () => buyKeg!.click());
    // The card hands its item along with the id (2026-09-16): the caller
    // shapes the purchase by what the card shows (a recruited hero's contract
    // asks first), so the two can never disagree about what is being bought.
    expect(buy).toHaveBeenCalledWith('keg_of_haste', expect.objectContaining({ id: 'keg_of_haste' }));
    await act(async () => root.unmount());
  });
});


it('separates an activated benefit from unused stock and enforces the inventory cap', async () => {
  const data = fixture();
  data.catalog = [{ ...data.catalog[1]!, id: 'item_troop_mage', name: 'MAGE TRAINING WRIT',
    maxOwned: 1, activation: { kind: 'troop', active: true } }];
  data.owned = [];
  const buy = vi.fn();
  const host = document.createElement('div'); const root = createRoot(host);
  const view = (): React.JSX.Element => <ShopCatalogView data={data} busyId={null} kind="all" onKind={vi.fn()} onBuy={buy} />;
  await act(async () => root.render(view()));
  expect(host.textContent).toContain('TRAINING UNLOCKED');
  expect(host.textContent).toContain('UNUSED ×0 · BAG LIMIT 1');
  expect(host.textContent).toContain('CANNOT BE ACTIVATED AGAIN');
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(buy).toHaveBeenCalledWith('item_troop_mage', expect.objectContaining({ id: 'item_troop_mage' }));
  data.owned = [{ itemId: 'item_troop_mage', qty: 1 }];
  await act(async () => root.render(view()));
  expect(host.textContent).toContain('UNUSED ×1 · BAG LIMIT 1');
  expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  expect(host.textContent).toContain('BAG LIMIT REACHED');
  await act(async () => root.unmount());
});

describe('a recruited hero\'s contract sells as a COPY (tester report 2026-09-16)', () => {
  // WHY: the reporter bought HERO CONTRACT: VEX a second time and read the
  // card's "UNUSED ×1" as a silent 3,000 KEEP loss. The copy IS delivered to
  // the bag; the button must say it is buying a copy before the tap, and hand
  // the caller the item so the purchase can ask first.
  const contract: ShopItemsDto['catalog'][number] = {
    id: 'item_hero_vex', name: 'HERO CONTRACT: VEX', kind: 'consumable', rarity: 'epic',
    weight: 2, costKeep: 3_000, asset: 'itm_contract_vex', desc: 'Recruits Vex.',
    acquisition: { type: 'keep_level', keepLevel: 5 }, maxOwned: 1,
    activation: { kind: 'hero', active: true, availableContracts: 0 },
  };
  it('labels the button BUY COPY once the hero is recruited on this base', () => {
    const html = renderToStaticMarkup(<ShopCatalogView
      data={{ catalog: [contract], owned: [] }} busyId={null} kind="all" onKind={vi.fn()} onBuy={vi.fn()}
    />);
    expect(html).toContain('BUY COPY · 3,000');
    expect(html).toContain('HERO RECRUITED ON THIS BASE');
  });
  it('an unrecruited hero contract still reads plain BUY', () => {
    const html = renderToStaticMarkup(<ShopCatalogView
      data={{ catalog: [{ ...contract, activation: { kind: 'hero', active: false, availableContracts: 0 } }], owned: [] }}
      busyId={null} kind="all" onKind={vi.fn()} onBuy={vi.fn()}
    />);
    expect(html).toContain('BUY · 3,000');
    expect(html).not.toContain('BUY COPY');
  });
  it('hands the tapped item to onBuy so the caller can confirm the copy', async () => {
    const buy = vi.fn();
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<ShopCatalogView
      data={{ catalog: [contract], owned: [] }} busyId={null} kind="all" onKind={vi.fn()} onBuy={buy}
    />));
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('BUY COPY'));
    await act(async () => button!.click());
    expect(buy).toHaveBeenCalledWith('item_hero_vex', expect.objectContaining({ id: 'item_hero_vex', activation: expect.objectContaining({ active: true }) }));
    await act(async () => root.unmount()); host.remove();
  });
});
