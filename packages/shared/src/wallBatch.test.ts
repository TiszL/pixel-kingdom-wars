import { describe, expect, it } from 'vitest';
import { BUILD_COUNT_CAP_BY_KEEP, GRID, PLOT_GEOMETRY, WALL_BATCH } from './constants';
import { plotBounds } from './plotGeometry';
import { WallBatchReceiptSchema, WallBatchRequestSchema, WallBatchStatusSchema } from './wallBatch';
const key = 'ab123456-1234-4123-8123-123456789abc';
const plot = plotBounds(PLOT_GEOMETRY.currentVersion);
const request = { idempotencyKey: key, baseId: null, tiles: [{ tx: 8, ty: 9 }, { tx: 9, ty: 9 }], maxCostShards: '900' };
const receipt = { version: 1, actor: '1'.repeat(32), idempotencyKey: key, request,
  receiptId: 'bc123456-1234-4123-8123-123456789abc', acceptedAt: '2034-06-01T00:00:00.000Z', funding: { currency: 'SHARDS', amount: '300' } };
describe('wall stroke frozen consent and immutable acceptance', () => {
  it('retains ordered signed tiles in new expansion receipts without relaxing consent', () => {
    const tiles = [{ tx: plot.min, ty: plot.max - 1 }, { tx: plot.min + 1, ty: plot.max - 1 }];
    const expanded = { ...request, tiles };
    expect(WallBatchRequestSchema.parse(expanded)).toEqual(expanded);
    expect(WallBatchReceiptSchema.parse({ ...receipt, request: expanded }).request).toEqual(expanded);
  });
  it('requires explicit scope and preserves original ordered unique sampled tiles', () => {
    expect(WallBatchRequestSchema.parse(request)).toEqual(request);
    expect(WallBatchRequestSchema.parse({ ...request, tiles: [...request.tiles].reverse() }).tiles).toEqual([...request.tiles].reverse());
    const missing = { idempotencyKey: key, tiles: request.tiles, maxCostShards: '900' };
    for (const bad of [missing, { ...request, idempotencyKey: key.toUpperCase() }, { ...request, baseId: key.toUpperCase() },
      { ...request, tiles: [request.tiles[0], request.tiles[0]] }, { ...request, tiles: [] },
      { ...request, tiles: [{ tx: plot.max, ty: 0 }] }, { ...request, tiles: [{ tx: plot.min - 1, ty: 0 }] },
      { ...request, tiles: [{ tx: 1.5, ty: 0 }] }, { ...request, tiles: [{ tx: 1, ty: 0, id: key }] },
      { ...request, currency: 'KEEP' }]) expect(WallBatchRequestSchema.safeParse(bad).success).toBe(false);
  });
  it('derives the maximum from unchanged wall-cap authority and never truncates excess tiles', () => {
    expect(WALL_BATCH.maxTiles).toBe(Math.max(...BUILD_COUNT_CAP_BY_KEEP.wall!));
    const tiles = Array.from({ length: WALL_BATCH.maxTiles }, (_, i) => ({ tx: i % GRID.plotTiles, ty: Math.floor(i / GRID.plotTiles) }));
    expect(WallBatchRequestSchema.parse({ ...request, tiles }).tiles).toHaveLength(WALL_BATCH.maxTiles);
    expect(WallBatchRequestSchema.safeParse({ ...request, tiles: [...tiles, { tx: GRID.plotTiles - 1, ty: GRID.plotTiles - 1 }] }).success).toBe(false);
  });
  it('rejects malformed decimals without throwing outside schema validation', () => {
    for (const amount of ['0', '-1', '01', '1.5', '1e3', '', 'bad', '9223372036854775808']) {
      expect(WallBatchRequestSchema.safeParse({ ...request, maxCostShards: amount }).success).toBe(false);
      expect(WallBatchReceiptSchema.safeParse({ ...receipt, funding: { currency: 'SHARDS', amount } }).success).toBe(false);
      expect(WallBatchReceiptSchema.safeParse({ ...receipt, request: { ...request, maxCostShards: amount } }).success).toBe(false);
    }
    expect(WallBatchRequestSchema.safeParse({ ...request, maxCostShards: '9223372036854775807' }).success).toBe(true);
  });
  it('binds actual funding to consent without later prices or current wall state', () => {
    expect(WallBatchReceiptSchema.parse(receipt)).toEqual(receipt);
    for (const bad of [{ ...receipt, idempotencyKey: receipt.receiptId }, { ...receipt, acceptedAt: '2034-06-01T00:00:00Z' },
      { ...receipt, funding: { currency: 'KEEP', amount: '300' } }, { ...receipt, funding: { currency: 'SHARDS', amount: '901' } },
      { ...receipt, buildings: [] }]) expect(WallBatchReceiptSchema.safeParse(bad).success).toBe(false);
    expect(WallBatchReceiptSchema.parse({ ...receipt, funding: { currency: 'SHARDS', amount: '1' } }).funding.amount).toBe('1');
  });
  it('separates support availability from exact actor/key history', () => {
    const status = { version: 1, wallet: receipt.actor, idempotencyKey: key, enabled: false, receipt };
    expect(WallBatchStatusSchema.parse(status)).toEqual(status);
    expect(WallBatchStatusSchema.parse({ ...status, receipt: null }).receipt).toBeNull();
    expect(WallBatchStatusSchema.safeParse({ ...status, wallet: '2'.repeat(32) }).success).toBe(false);
    expect(WallBatchStatusSchema.safeParse({ ...status, idempotencyKey: receipt.receiptId }).success).toBe(false);
  });
});
