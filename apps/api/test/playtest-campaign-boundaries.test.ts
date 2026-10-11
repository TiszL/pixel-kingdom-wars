import { expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { finalizePlaytestCampaign } from '../src/game/playtestCampaigns';

it('rejects a request sampled before the DB close instead of crossing the boundary without a drain barrier', async () => {
  const endAt = new Date('2040-01-15T12:30:00.500Z');
  // The next sample would be after close. A request that starts before close
  // must retry, not skip the barrier and later enter a now-eligible mutation.
  const execute = vi.fn().mockResolvedValueOnce([{ now: new Date(+endAt - 1) }]).mockResolvedValue([{ now: new Date(+endAt + 1) }]);
  const transaction = vi.fn().mockResolvedValue({ revision: 2 });
  const db = { execute, transaction,
    select: () => ({ from: () => ({ where: async () => [{ id: 'rewarded-playtest', endAt, startAt: new Date('2040-01-01T12:30:00.500Z'), finalizedAt: null, cancelledAt: null }] }) }),
  } as unknown as Db;
  await expect(finalizePlaytestCampaign(db, 'rewarded-playtest', 'admin', { requestId: 'before-close', revision: 1 }, []))
    .rejects.toMatchObject({ statusCode: 409 });
  expect(transaction).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(1);
});
