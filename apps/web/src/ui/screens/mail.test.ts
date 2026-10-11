import { createHash } from 'node:crypto';
import { MAIL } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  adminRewardMailContentHash, canonicalRewardMailPayload, mailRewardNeedsBase,
  parseAdminMailRewardDraft, type MailAttachment,
} from './mailModel';

describe('mail authority helpers', () => {
  it('hashes the exact normalized admin reward body the API verifies', async () => {
    const input = {
      recipientWallet: 'MailWallet1111111111111111111111111111111',
      idempotencyKey: 'mail-reward-0001',
      subject: '  Tournament reward  ',
      body: '  Thanks for playing.  ',
      attachments: [
        { kind: 'KEEP', amount: '000125' },
        { kind: 'ITEM', itemId: 'powder_charge', qty: 2 },
      ] as MailAttachment[],
    };
    const canonical = JSON.stringify([
      input.recipientWallet, input.idempotencyKey, 'Tournament reward', 'Thanks for playing.',
      [['KEEP', '125'], ['ITEM', 'powder_charge', 2]],
    ]);
    expect(canonicalRewardMailPayload(input)).toBe(canonical);
    expect(await adminRewardMailContentHash(input))
      .toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it('requires an explicit deed for base-owned attachments but not KEEP', () => {
    expect(mailRewardNeedsBase({ attachments: [{ kind: 'KEEP', amount: '10' }] })).toBe(false);
    expect(mailRewardNeedsBase({ attachments: [{ kind: 'SHARDS', amount: '10' }] })).toBe(true);
    expect(mailRewardNeedsBase({ attachments: [{ kind: 'ITEM', itemId: 'powder_charge', qty: 1 }] })).toBe(true);
  });

  it('refuses the complete reward intent when KEEP is invalid beside valid SHARDS', () => {
    expect(parseAdminMailRewardDraft({
      keep: '0', shards: '5', itemId: '', qty: '',
    })).toEqual({ ok: false, error: 'KEEP MUST BE POSITIVE AND WITHIN THE SHOWN LIMIT' });
  });

  it.each([
    { keep: '', shards: '', itemId: 'powder_charge', qty: '' },
    { keep: '', shards: '', itemId: '', qty: '2' },
  ])('refuses an incomplete item and quantity pair: %o', (draft) => {
    expect(parseAdminMailRewardDraft(draft)).toEqual({
      ok: false,
      error: 'SELECT BOTH A CONSUMABLE AND QUANTITY',
    });
  });

  it.each([
    {
      draft: { keep: String(MAIL.rewardKeepMax + 1), shards: '5', itemId: '', qty: '' },
      error: 'KEEP MUST BE POSITIVE AND WITHIN THE SHOWN LIMIT',
    },
    {
      draft: { keep: '5', shards: String(MAIL.rewardShardsMax + 1), itemId: '', qty: '' },
      error: 'SHARDS MUST BE POSITIVE AND WITHIN THE SHOWN LIMIT',
    },
    {
      draft: { keep: '', shards: '5', itemId: 'not_an_item', qty: '1' },
      error: 'SELECT AN APPROVED STACKABLE CONSUMABLE',
    },
    {
      draft: {
        keep: '5', shards: '', itemId: 'powder_charge', qty: String(MAIL.rewardConsumableQtyMax + 1),
      },
      error: 'QUANTITY MUST BE POSITIVE AND WITHIN THE SHOWN LIMIT',
    },
  ])('refuses a populated invalid reward field instead of omitting it: $error', ({ draft, error }) => {
    expect(parseAdminMailRewardDraft(draft)).toEqual({ ok: false, error });
  });

  it('normalizes every valid populated reward field into one bounded intent', () => {
    expect(parseAdminMailRewardDraft({
      keep: '0005', shards: '12', itemId: 'powder_charge', qty: '2',
    })).toEqual({
      ok: true,
      attachments: [
        { kind: 'KEEP', amount: '5' },
        { kind: 'SHARDS', amount: '12' },
        { kind: 'ITEM', itemId: 'powder_charge', qty: 2 },
      ],
    });
  });
});
