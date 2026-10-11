import { describe, expect, it } from 'vitest';
import {
  basketCount,
  claimPrimaryLook,
  consentArmStart,
  forgeOutcomeLine,
  furnaceLabel,
  furnaceLoadText,
  gemsPrimaryLook,
  gemSpendArms,
  gemSpendConfirmLabel,
  gemSpendPrimaryLook,
  goldForgeDefaultTab,
  goldForgeTabs,
  heldStrip,
  heroStatusLine,
  isPositiveAmount,
  quoteArmStart,
  smeltPrimaryCommand,
  smeltPrimaryLook,
  smeltSealIcons,
  tileIconDp,
  walletTag,
} from './GoldForgeLogic';
import type { ClaimUi, GemsUi, GemSpendUi, SmeltTileUi } from './goldForgeModel';

/**
 * Case-for-case port of native GoldForgeLogicTest.kt at 28609e71.
 * Its 13 case names and 99 assertion sites (110 checks with loops expanded) are retained.
 * Amounts and dates below are native test fixtures, never production defaults.
 */
describe('GoldForgeLogic native parity', () => {
  const claim: ClaimUi = {
    ready: '1,240',
    readyDays: 3,
    estimate: '42',
    walletLabel: 'Seeker wallet',
    walletLast4: '8f2K',
    lock: null,
    stage: 'READY',
    nextCoinsIn: '6h 20m',
    canResumeSaved: false,
  };
  const gems: GemsUi = {
    rate: '1 KEEP = 1 GEM',
    amount: '500',
    pay: '500',
    walletKeep: '2,480',
    walletAfter: '1,980',
    quick: ['100', '500', '1,000', 'MAX'],
    selectedQuick: '500',
    min: '1',
    max: '2,480',
    short: null,
    shortfallFor: null,
    stage: 'READY',
    pendingRecovery: false,
    toShardsAvailable: true,
    swapOffered: false,
  };
  const spend: GemSpendUi = {
    kind: 'FINISH',
    title: 'FINISH NOW?',
    subjectArt: 'craft:workshop_t2_construction',
    subjectName: 'WORKSHOP',
    subjectLine: 'Lv 2 › 3',
    progress: 0.5,
    timeLeft: '2h 14m',
    price: { currency: 'GEMS', amount: '120', status: 'OK' },
    have: '1,250',
    after: '1,130',
    short: null,
    quotedAtMs: 0,
    stage: 'READY',
  };

  // SPEC §1 Entry: an explicit tab wins; ready coins open CLAIM, otherwise SMELT.
  it('the default tab follows the entry order', () => {
    const tabs = ['SMELT', 'CLAIM', 'GEMS'];
    expect(goldForgeDefaultTab('gems', tabs, true)).toBe('GEMS');
    expect(goldForgeDefaultTab(null, tabs, true)).toBe('CLAIM');
    expect(goldForgeDefaultTab(null, tabs, false)).toBe('SMELT');
    expect(goldForgeDefaultTab('legacy', tabs, true)).toBe('CLAIM');
    expect(goldForgeDefaultTab(null, ['GEMS'], false)).toBe('GEMS');
    expect(goldForgeDefaultTab('smelt', [], true)).toBeNull();
  });

  // SPEC §1 Tabs: a locked CLAIM stays visible; only the supplied LEGACY state adds its tab.
  it('the tab row never hides CLAIM and shows LEGACY only on request', () => {
    const plain = goldForgeTabs(false, 0, false);
    expect(plain.map(tab => tab.id)).toEqual(['SMELT', 'CLAIM', 'GEMS']);
    expect(plain.every(tab => !tab.locked && tab.badge === null)).toBe(true);
    const busy = goldForgeTabs(true, 1, true);
    expect(busy.map(tab => tab.id)).toEqual(['SMELT', 'CLAIM', 'GEMS', 'LEGACY']);
    expect(busy[1]?.badge?.text).toBe('!');
    expect(busy[2]?.badge?.text).toBe('1');
  });

  // DESIGN-SYSTEM §9: an unknown or zero amount is never money available to claim.
  it('only a known positive amount is claimable', () => {
    for (const value of [null, '', '…', '0', '0.00', '-5', '1.2M']) {
      expect(isPositiveAmount(value), String(value)).toBe(false);
    }
    for (const value of ['1,240', '0.5', '12', '312.5']) {
      expect(isPositiveAmount(value), value).toBe(true);
    }
  });

  // SPEC §1 hero copy: unknown time is an ellipsis; only a working forge has a gold dot.
  it('the hero chip says what the forge is doing', () => {
    const forging = heroStatusLine({ kind: 'FORGING', time: null });
    expect(forging.emphasis).toBe('…');
    expect(forging.dot).toBe('GOLD');
    expect(heroStatusLine({ kind: 'AT_REST', reason: 'upgrading' }).text).toBe('Forge at rest · upgrading');
    expect(heroStatusLine({ kind: 'RECONNECTING' }).dot).toBe('STONE');
    expect(heroStatusLine({ kind: 'UNDER_CONSTRUCTION', time: '1h 12m' }).emphasis).toBe('1h 12m');
  });

  // Design correction 7: only an authoritative refusal permits a fresh retry or a nothing-moved assertion.
  it('an uncertain claim is checked, never retried as if nothing happened', () => {
    const refused = claimPrimaryLook({ ...claim, stage: 'FAILED', failure: 'REFUSED' });
    expect(refused.action).toBe('RETRY');
    expect(refused.verb).toBe('RED');
    const uncertain = claimPrimaryLook({ ...claim, stage: 'FAILED', failure: 'UNCERTAIN' });
    expect(uncertain.action).toBe('CONTINUE');
    expect(uncertain.verb).toBe('STONE');
    expect(claimPrimaryLook({ ...claim, stage: 'FAILED', failure: null })).toEqual(uncertain);
    expect(forgeOutcomeLine('claim', 'REFUSED')).toBe('Wallet said no. Nothing was sent.');
    for (const action of ['claim', 'purchase', 'finish']) {
      expect(forgeOutcomeLine(action, 'UNCERTAIN').includes('Nothing was')).toBe(false);
    }
  });

  // SPEC §4 states: each CLAIM state keeps one honest primary.
  it('the CLAIM primary follows the states table', () => {
    const ready = claimPrimaryLook(claim);
    expect(ready.action).toBe('CLAIM');
    expect(ready.sub).toBe('1,240 KEEP to your wallet');
    expect(claimPrimaryLook({ ...claim, phase: 'LOADING' }).state).toBe('BUSY');
    const error = claimPrimaryLook({ ...claim, phase: 'ERROR' });
    expect(error.state).toBe('DISABLED');
    expect(error.sub).toBe('waiting for the server');
    const locked = claimPrimaryLook({
      ...claim,
      phase: 'LOCKED',
      lock: { date: 'Wed 14 Oct', reason: 'after the first island auction' },
    });
    expect(locked.state).toBe('LOCKED');
    expect(locked.sub).toBe('opens Wed 14 Oct');
    expect(locked.action).toBe('EXPLAIN_LOCK');
    expect(claimPrimaryLook({ ...claim, canResumeSaved: true }).label).toBe('CONTINUE CLAIM');
    const wallet = claimPrimaryLook({ ...claim, stage: 'CHECK_WALLET' });
    expect(wallet.state).toBe('ENABLED');
    expect(wallet.action).toBe('CONTINUE');
    expect(claimPrimaryLook({ ...claim, stage: 'SENDING' }).state).toBe('BUSY');
    expect(claimPrimaryLook({ ...claim, stage: 'SENT' }).verb).toBe('MOSS');
    expect(claimPrimaryLook({ ...claim, ready: '0' }).action).toBe('NONE');
    expect(claimPrimaryLook({ ...claim, ready: '…' }).action).toBe('NONE');
  });

  // SPEC §5: an insufficient wallet disables BUY; pending recovery continues; Gems off has no primary.
  it('the GEMS primary never buys what the wallet cannot pay', () => {
    expect(gemsPrimaryLook(gems)?.action).toBe('BUY');
    expect(gemsPrimaryLook(gems)?.sub).toBe('paid with 500 KEEP from your wallet');
    const short = gemsPrimaryLook({ ...gems, walletShort: true });
    expect(short?.state).toBe('DISABLED');
    expect(short?.reason).toBe('Your wallet has 2,480 KEEP');
    expect(gemsPrimaryLook({ ...gems, pendingRecovery: true })?.action).toBe('CONTINUE');
    expect(gemsPrimaryLook({ ...gems, phase: 'OFF' })).toBeNull();
    expect(gemsPrimaryLook({ ...gems, phase: 'ERROR' })?.action).toBe('RETRY');
    expect(gemsPrimaryLook({ ...gems, amount: '…' })?.state).toBe('BUSY');
  });

  // SPEC §6: missing prices wait or explain; short routes to Gems; only server zero bypasses arming.
  it('the speed-up primary follows the live price', () => {
    expect(gemSpendPrimaryLook(spend).action).toBe('CONFIRM');
    expect(gemSpendArms(spend)).toBe(true);
    expect(gemSpendPrimaryLook({
      ...spend,
      price: { currency: 'GEMS', amount: null, status: 'CHECKING' },
    }).state).toBe('BUSY');
    const unavailable = gemSpendPrimaryLook({
      ...spend,
      price: { currency: 'GEMS', amount: null, status: 'UNAVAILABLE' },
    });
    expect(unavailable.state).toBe('DISABLED');
    expect(unavailable.reason != null).toBe(true);
    const short = gemSpendPrimaryLook({ ...spend, short: '40' });
    expect(short.action).toBe('GET_GEMS');
    expect(short.verb).toBe('BLUE');
    expect(gemSpendPrimaryLook({
      ...spend,
      price: { currency: 'GEMS', amount: '120', status: 'SHORT' },
    }).action).toBe('GET_GEMS');
    const free: GemSpendUi = {
      ...spend,
      price: { currency: 'GEMS', amount: '0', status: 'SERVER_ZERO' },
    };
    expect(gemSpendArms(free)).toBe(false);
    expect(gemSpendPrimaryLook(free).action).toBe('CONFIRM');
    expect(gemSpendPrimaryLook({ ...spend, stage: 'FAILED', failure: 'REFUSED' }).action).toBe('RETRY');
    expect(gemSpendPrimaryLook({ ...spend, stage: 'FAILED' }).action).toBe('NONE');
    expect(gemSpendConfirmLabel('SKIP')).toBe('SKIP');
  });

  // SPEC §3: HELD finds a raid, QUALIFIED has no button, and unavailable SMELT keeps its reason.
  it('the SMELT primary follows the furnace state', () => {
    const held = smeltPrimaryLook('HELD', smeltPrimaryCommand('HELD', 0));
    expect(held?.action).toBe('FIND_RAID');
    expect(held?.verb).toBe('RED');
    expect(smeltPrimaryLook('QUALIFIED', smeltPrimaryCommand('QUALIFIED', 0, '6h 20m'))).toBeNull();
    expect(smeltPrimaryCommand('QUALIFIED', 0, '6h 20m').caption).toBe('PAYOUT IN 6h 20m');
    expect(smeltPrimaryCommand('QUALIFIED', 0).caption).toBe('PAYOUT IN …');
    const choosing = smeltPrimaryLook('CHOOSING', smeltPrimaryCommand('CHOOSING', 7));
    expect(choosing?.action).toBe('SMELT');
    expect(choosing?.verb).toBe('GOLD');
    expect(choosing?.sub).toBe('7 items');
    expect(smeltPrimaryCommand('CHOOSING', 1).sub).toBe('1 item');
    const empty = smeltPrimaryLook('CHOOSING', smeltPrimaryCommand('CHOOSING', 0));
    expect(empty?.state).toBe('DISABLED');
    expect(empty?.action).toBe('NONE');
    const paused = smeltPrimaryLook('PAUSED', smeltPrimaryCommand('PAUSED', 3));
    expect(paused?.reason).toBe('New smelting is paused');
    expect(smeltPrimaryLook('NOT_READY', smeltPrimaryCommand('NOT_READY', 0))?.state).toBe('LOCKED');
    expect(smeltPrimaryLook('ERROR', smeltPrimaryCommand('ERROR', 0))?.action).toBe('RETRY');
    expect(smeltPrimaryLook('LOADING', smeltPrimaryCommand('CHOOSING', 3))?.state).toBe('BUSY');
  });

  // SPEC §3a: only a positive choosing basket is green; an absent cap is explicitly uncapped.
  it('the furnace header and load label use game words', () => {
    expect(furnaceLabel('free')).toBe('Free furnace');
    expect(furnaceLabel('DEED')).toBe('Deed furnace');
    expect(furnaceLabel('')).toBe('…');
    expect(furnaceLoadText('CHOOSING', '0', '1,800', '5,000')).toEqual({ basket: '+1,800', rest: ' of 5,000' });
    expect(furnaceLoadText('HELD', '1,800', '1,800', '5,000')).toEqual({ basket: null, rest: '1,800 of 5,000' });
    expect(furnaceLoadText('CHOOSING', '0', '0', '5,000')).toEqual({ basket: null, rest: '0 of 5,000' });
    expect(furnaceLoadText('HELD', '10', null, null)).toEqual({ basket: null, rest: 'Uncapped today' });
    expect(furnaceLoadText('CHOOSING', '0', '50', null)).toEqual({ basket: '+50', rest: ' · Uncapped today' });
  });

  // SPEC §3c.4 / §3b: overflow occupies one held slot; the Seal takes only the first two chosen icons.
  it('the held strip and seal icons stay within their slots', () => {
    const tile = (id: string, chosen = 1): SmeltTileUi => ({
      resourceId: id,
      icon: `icon-${id}`,
      have: 'x1',
      chosen,
      unitValue: '1',
      source: 'Workshop',
    });
    const [threeShown, threeHidden] = heldStrip(Array.from({ length: 3 }, (_, index) => tile(String(index))));
    expect([threeShown.length, threeHidden]).toEqual([3, 0]);
    const [fiveShown, fiveHidden] = heldStrip(Array.from({ length: 5 }, (_, index) => tile(String(index))));
    expect([fiveShown.length, fiveHidden]).toEqual([2, 3]);
    expect(smeltSealIcons([tile('a', 0), tile('b'), tile('c'), tile('d')])).toEqual(['icon-b', 'icon-c']);
    expect(basketCount([tile('a', 2), tile('b', 5), tile('c', 0)])).toBe(7);
    expect(tileIconDp('shards')).toBe(36);
    expect(tileIconDp('craft:inv_crownsteel')).toBe(32);
  });

  // SPEC §3b / §6a: consent is required; a later quote restarts the arming interval.
  it('seals arm only after consent and restart on a new quote', () => {
    expect(consentArmStart(1_000, null)).toBeNull();
    expect(consentArmStart(1_000, 5_000)).toBe(5_000);
    expect(consentArmStart(1_000, 500)).toBe(1_000);
    expect(quoteArmStart(1_000, 9_000)).toBe(9_000);
    expect(quoteArmStart(1_000, -9_223_372_036_854_775_808)).toBe(1_000);
  });

  // SPEC §4c: the Seal names the wallet app, never an address.
  it('the wallet tag is the app name only', () => {
    expect(walletTag('Seeker wallet')).toBe('SEEKER');
    expect(walletTag('Phantom')).toBe('PHANTOM');
    expect(walletTag(null)).toBe('WALLET');
    expect(walletTag('  ')).toBe('WALLET');
  });
});
