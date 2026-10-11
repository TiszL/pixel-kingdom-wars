import { describe, expect, it } from 'vitest';
import { gemsAvailable, gemsCommand, gemsReceiptPath, gemsSpendFunding, parseGemsIntent, parseGemsOverview, parseGemsReceipt } from './contracts';
import { base, envelope, identity, inner, intent, overview, proof } from './fixtures.test-support';

describe('Gems wire contract', () => {
  it.each(['gems-from-keep', 'gems-to-shards', 'gems-task-claim'] as const)('%s verifies historical exact proof and leaves matching unknown pending', kind => {
    const saved = intent(kind);
    expect(parseGemsReceipt(proof(saved), saved, identity.wallet)?.amount).toBe(kind === 'gems-task-claim' ? '10' : '20');
    expect(parseGemsReceipt(envelope(saved, null), saved, identity.wallet)).toBeNull();
    expect(gemsCommand(saved).body.idempotencyKey).toBe(saved.idempotencyKey);
    expect(gemsReceiptPath(saved)).toContain(kind === 'gems-to-shards' ? '/receipt?' : '/by-key/');
    for (const changed of [{ wallet: 'other' }, { request: { idempotencyKey: 'other-key' } }, { receiptId: 'invalid' }, { acceptedAt: 'yesterday' }, { version: 2 }])
      expect(() => parseGemsReceipt(envelope(saved, { ...inner(saved), ...changed }), saved, identity.wallet)).toThrow();
  });
  it.each(['gems-from-keep', 'gems-to-shards'] as const)('%s rejects wrong funding and invented conversion rates or output', kind => {
    const saved = intent(kind);
    for (const changed of [{ funding: { currency: 'SOL', amount: '10' } }, { funding: { currency: kind === 'gems-from-keep' ? 'KEEP' : 'GEMS', amount: '11' } },
      { result: kind === 'gems-from-keep' ? { gems: '19', rate: 2 } : { shards: '19', rate: 2 } },
      { result: kind === 'gems-from-keep' ? { gems: '20', rate: '2' } : { shards: '20', rate: '2' } }])
      expect(() => parseGemsReceipt(envelope(saved, { ...inner(saved), ...changed }), saved, identity.wallet)).toThrow();
  });
  it('rejects scope substitution and by-key wrapper disagreement', () => {
    const conversion = intent('gems-to-shards'), task = intent('gems-task-claim');
    expect(() => parseGemsReceipt({ ...proof(conversion), baseId: null }, conversion, identity.wallet)).toThrow();
    expect(() => parseGemsReceipt(envelope(task, { ...inner(task), taskId: 'other-task' }), task, identity.wallet)).toThrow();
    expect(() => parseGemsReceipt({ ...proof(task), idempotencyKey: 'other-key' }, task, identity.wallet)).toThrow();
    expect(() => parseGemsReceipt({ ...envelope(task, null), receipt: inner(task) }, task, identity.wallet)).toThrow();
  });
  it('preserves exact decimal strings and rejects malformed intents before storage', () => {
    expect(parseGemsIntent({ ...intent('gems-to-shards'), baseId: base.toUpperCase() })).toEqual(intent('gems-to-shards'));
    for (const keep of ['0', '01', '-1', '1.5', '1e2', '9'.repeat(33)]) expect(() => parseGemsIntent({ ...intent(), keep })).toThrow();
    expect(parseGemsIntent({ ...intent(), keep: '9007199254740993' })).toHaveProperty('keep', '9007199254740993');
    expect(() => parseGemsIntent({ ...intent('gems-task-claim'), taskId: '../claim' })).toThrow();
    expect(() => parseGemsIntent({ ...intent(), extra: true })).toThrow();
  });
  it('legacy absent features default off and valid overview uses server rates and bounds', () => {
    for (const legacy of [null, {}, { keep: '10' }, { features: { gems: { version: 2, receipts: 1 } } }]) expect(gemsAvailable(legacy)).toBe(false);
    expect(parseGemsOverview(overview())).toMatchObject({ gemsPerKeep: 2, shardsPerGem: 2, minConvertKeep: 1, maxConvertKeepPerTx: 1000 });
    expect(() => parseGemsOverview({ ...overview(), minConvertKeep: 1001 })).toThrow();
    expect(() => parseGemsOverview({ ...overview(), gems: 100 })).toThrow();
  });
  it('Gems-first pricing always names the whole KEEP fallback and never sums the balances', () => {
    const b = (gems: string, keep: string) => ({ gems, keep, features: { gems: { version: 1, receipts: 1 } } });
    expect(gemsSpendFunding('10', b('10', '10'))).toEqual({ preferred: 'GEMS', fallback: 'KEEP', amount: '10', expected: 'GEMS' });
    expect(gemsSpendFunding('10', b('9', '10')).expected).toBe('KEEP');
    expect(gemsSpendFunding('10', b('9', '9')).expected).toBeNull();
    expect(() => gemsSpendFunding('10', { keep: '10' })).toThrow();
  });
  it('valid historical arithmetic cannot substitute a different reviewed conversion or task reward', () => {
    for (const kind of ['gems-from-keep', 'gems-to-shards', 'gems-task-claim'] as const) {
      const saved = parseGemsIntent({ ...intent(kind), consent: { rate: kind === 'gems-task-claim' ? null : 3, output: '30' } });
      expect(() => parseGemsReceipt(proof(saved), saved, identity.wallet)).toThrow('reviewed');
      expect(gemsCommand(saved).body).toEqual({ ...gemsCommand(intent(kind)).body, expected: saved.consent });
      expect(gemsReceiptPath(saved)).not.toContain('expected');
    }
  });
  it('rejects malformed frozen terms and preserves legacy receipt readability', () => {
    for (const consent of [{ rate: 2, output: '19' }, { rate: null, output: '20' }, { rate: 1.5, output: '15' }, { rate: 2, output: '020' }, { rate: 2, output: '20', extra: true }])
      expect(() => parseGemsIntent({ ...intent(), consent })).toThrow();
    expect(() => parseGemsIntent({ ...intent('gems-task-claim'), consent: { rate: 1, output: '10' } })).toThrow();
    expect(parseGemsReceipt(proof(intent()), intent(), identity.wallet)?.amount).toBe('20');
  });
});
