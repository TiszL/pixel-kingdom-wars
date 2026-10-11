/** Pure mail DTO/authority helpers shared by the lazy screen and focused tests. */
import { MAIL } from '@shardkeep/shared';

export type MailAttachment =
  | { kind: 'KEEP'; amount: string }
  | { kind: 'SHARDS'; amount: string }
  | { kind: 'ITEM'; itemId: string; qty: number };

export interface AdminMailRewardDraft {
  keep: string;
  shards: string;
  itemId: string;
  qty: string;
}

export type AdminMailRewardDraftResult =
  | { ok: true; attachments: MailAttachment[] }
  | { ok: false; error: string };

function positiveInteger(value: string, max: number): string | null {
  if (!/^\d+$/.test(value)) return null;
  const normalized = BigInt(value).toString();
  return BigInt(normalized) > 0n && BigInt(normalized) <= BigInt(max) ? normalized : null;
}

/** Parses the complete reward intent atomically. A populated invalid field must
 * reject the draft instead of disappearing beside another valid attachment. */
export function parseAdminMailRewardDraft(fields: AdminMailRewardDraft): AdminMailRewardDraftResult {
  const attachments: MailAttachment[] = [];

  if (fields.keep !== '') {
    const amount = positiveInteger(fields.keep, MAIL.rewardKeepMax);
    if (!amount) return { ok: false, error: 'KEEP MUST BE POSITIVE AND WITHIN THE SHOWN LIMIT' };
    attachments.push({ kind: 'KEEP', amount });
  }

  if (fields.shards !== '') {
    const amount = positiveInteger(fields.shards, MAIL.rewardShardsMax);
    if (!amount) return { ok: false, error: 'SHARDS MUST BE POSITIVE AND WITHIN THE SHOWN LIMIT' };
    attachments.push({ kind: 'SHARDS', amount });
  }

  if ((fields.itemId === '') !== (fields.qty === '')) {
    return { ok: false, error: 'SELECT BOTH A CONSUMABLE AND QUANTITY' };
  }
  if (fields.itemId !== '') {
    if (!MAIL.approvedStackableConsumableIds.some((id) => id === fields.itemId)) {
      return { ok: false, error: 'SELECT AN APPROVED STACKABLE CONSUMABLE' };
    }
    const qty = positiveInteger(fields.qty, MAIL.rewardConsumableQtyMax);
    if (!qty) return { ok: false, error: 'QUANTITY MUST BE POSITIVE AND WITHIN THE SHOWN LIMIT' };
    attachments.push({ kind: 'ITEM', itemId: fields.itemId, qty: Number(qty) });
  }

  if (attachments.length > MAIL.maxAttachments) {
    return { ok: false, error: `REWARDS ARE LIMITED TO ${MAIL.maxAttachments} ATTACHMENTS` };
  }
  return { ok: true, attachments };
}

export function mailRewardNeedsBase(message: { attachments: readonly MailAttachment[] }): boolean {
  return message.attachments.some((attachment) => attachment.kind === 'SHARDS' || attachment.kind === 'ITEM');
}

function canonicalAttachment(attachment: MailAttachment): readonly unknown[] {
  return attachment.kind === 'ITEM'
    ? [attachment.kind, attachment.itemId, attachment.qty]
    : [attachment.kind, BigInt(attachment.amount).toString()];
}

/** Must remain byte-identical to apps/api mail/service.ts. Exported so a
 * focused test catches normalization/order drift before reward sends ship. */
export function canonicalRewardMailPayload(input: {
  recipientWallet: string;
  idempotencyKey: string;
  subject: string;
  body: string;
  attachments: readonly MailAttachment[];
}): string {
  return JSON.stringify([
    input.recipientWallet,
    input.idempotencyKey,
    input.subject.trim(),
    input.body.trim(),
    input.attachments.map(canonicalAttachment),
  ]);
}

export async function adminRewardMailContentHash(input: Parameters<typeof canonicalRewardMailPayload>[0]): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonicalRewardMailPayload(input)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
