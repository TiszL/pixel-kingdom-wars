/** E2-GEMS-CONTRACT §2. Runtime validation stays in this lazy client family; no
 * game costs/rates are copied here. Historical receipts own the accepted rate. */
export type GemsKind = 'gems-from-keep' | 'gems-to-shards' | 'gems-task-claim';
export type GemsInput = { kind: 'gems-from-keep'; keep: string }
  | { kind: 'gems-to-shards'; gems: string; baseId: string | null }
  | { kind: 'gems-task-claim'; taskId: string };
export type GemsConsent = Readonly<{ rate: number | null; output: string }>;
// Older journals remain readable for receipt recovery, but cannot authorize a
// new POST without the exact output that the player originally reviewed.
export type GemsIntent = GemsInput & { idempotencyKey: string; consent?: GemsConsent };
export type GemsReceipt = { receiptId: string; acceptedAt: string; amount: string; currency: 'GEMS' | 'SHARDS';
  funding: { currency: 'KEEP' | 'GEMS'; amount: string } | null; rate: number | null };
export function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Gems response.');
  return raw as Record<string, unknown>;
}
export function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  const r = object(raw);
  if (Object.keys(r).length !== keys.length || keys.some(key => !(key in r))) throw new Error('Invalid saved Gems fields.');
  return r;
}
function text(raw: unknown): string { if (typeof raw !== 'string') throw new Error('Expected Gems text.'); return raw; }
export function amount(raw: unknown, positive = false): string {
  const value = text(raw);
  if (value.length > 32 || !/^(0|[1-9][0-9]*)$/.test(value) || positive && value === '0') throw new Error('Enter a whole currency amount.');
  return value;
}
function integer(raw: unknown): number {
  if (!Number.isSafeInteger(raw) || (raw as number) <= 0) throw new Error('Invalid Gems rate or bound.');
  return raw as number;
}
function uuid(raw: unknown): string {
  const value = text(raw);
  if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)) throw new Error('Invalid Gems receipt or base ID.');
  return value.toLowerCase();
}
function timestamp(raw: unknown): string {
  const value = text(raw);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid Gems receipt time.');
  return value;
}
export function parseGemsIntent(raw: unknown): GemsIntent {
  const r = object(raw); const idempotencyKey = text(r.idempotencyKey);
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new Error('Invalid saved Gems key.');
  const consentKeys = Object.hasOwn(r, 'consent') ? ['consent'] : [];
  const finish = (intent: GemsIntent): GemsIntent => {
    if (consentKeys.length === 0) return intent;
    const c = exact(r.consent, ['rate', 'output']), output = amount(c.output, true);
    if (intent.kind === 'gems-task-claim') {
      if (c.rate !== null) throw new Error('Invalid saved task consent.');
      return { ...intent, consent: { rate: null, output } };
    }
    const rate = integer(c.rate), input = intent.kind === 'gems-from-keep' ? intent.keep : intent.gems;
    if (BigInt(input) * BigInt(rate) !== BigInt(output)) throw new Error('Invalid saved conversion consent.');
    return { ...intent, consent: { rate, output } };
  };
  if (r.kind === 'gems-from-keep') {
    exact(r, ['kind', 'idempotencyKey', 'keep', ...consentKeys]); return finish({ kind: r.kind, idempotencyKey, keep: amount(r.keep, true) });
  }
  if (r.kind === 'gems-to-shards') {
    exact(r, ['kind', 'idempotencyKey', 'gems', 'baseId', ...consentKeys]);
    return finish({ kind: r.kind, idempotencyKey, gems: amount(r.gems, true), baseId: r.baseId === null ? null : uuid(r.baseId) });
  }
  if (r.kind === 'gems-task-claim') {
    exact(r, ['kind', 'idempotencyKey', 'taskId', ...consentKeys]); const taskId = text(r.taskId);
    if (!/^[a-z0-9_-]{1,64}$/.test(taskId)) throw new Error('Invalid Gems task.');
    return finish({ kind: r.kind, idempotencyKey, taskId });
  }
  throw new Error('Unknown saved Gems operation.');
}
export function gemsCommand(intent: GemsIntent): { path: string; body: Record<string, string | GemsConsent> } {
  const i = parseGemsIntent(intent), idempotencyKey = i.idempotencyKey;
  const guard = i.consent ? { expected: i.consent } : {};
  if (i.kind === 'gems-from-keep') return { path: '/gems/from-keep', body: { keep: i.keep, idempotencyKey, ...guard } };
  if (i.kind === 'gems-to-shards') return { path: '/gems/to-shards', body: { gems: i.gems, idempotencyKey, ...(i.baseId === null ? {} : { baseId: i.baseId }), ...guard } };
  return { path: `/gems/tasks/${i.taskId}/claim`, body: { idempotencyKey, ...guard } };
}
export function gemsReceiptPath(intent: GemsIntent): string {
  const command = gemsCommand(intent);
  // Reads resolve the original key/body. Exact expected terms are proven in
  // the returned receipt; they are never a new current-price read constraint.
  return intent.kind === 'gems-to-shards' ? `${command.path}/receipt?${new URLSearchParams({ gems: intent.gems,
    idempotencyKey: intent.idempotencyKey, ...(intent.baseId === null ? {} : { baseId: intent.baseId }) })}`
    : `${command.path}/by-key/${encodeURIComponent(intent.idempotencyKey)}`;
}
export function parseGemsReceipt(raw: unknown, intent: GemsIntent, wallet: string): GemsReceipt | null {
  const i = parseGemsIntent(intent); let r = object(raw);
  if (i.kind !== 'gems-to-shards') {
    if (r.wallet !== wallet || r.idempotencyKey !== i.idempotencyKey) throw new Error('The Gems receipt belongs to another account or key.');
    timestamp(r.serverNow);
    if (r.status === 'unknown' && r.receipt === null) return null;
    if (r.status !== 'accepted') throw new Error('Invalid Gems receipt status.');
    r = object(r.receipt);
    if (r.status !== 'accepted') throw new Error('Invalid inner Gems receipt status.');
  }
  if (r.version !== 1) throw new Error('This Gems receipt needs a compatible client.');
  if (r.status === 'unknown' && r.idempotencyKey === i.idempotencyKey) return null;
  if (r.status !== 'accepted' || r.wallet !== wallet) throw new Error('The Gems receipt does not prove this account request.');
  const receiptId = uuid(r.receiptId), acceptedAt = timestamp(r.acceptedAt), result = object(r.result);
  const expected: Record<string, string | GemsConsent> = { ...gemsCommand(i).body, ...(i.kind === 'gems-task-claim' ? { taskId: i.taskId } : {}) };
  const request = exact(r.request, Object.keys(expected));
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'expected') {
      const received = exact(request.expected, ['rate', 'output']), terms = value as GemsConsent;
      if (received.rate !== terms.rate || received.output !== terms.output) throw new Error('The Gems receipt differs from the reviewed terms.');
    } else if (request[key] !== value) throw new Error('The Gems receipt differs from the saved request.');
  }
  if (i.kind === 'gems-task-claim') {
    if (r.taskId !== i.taskId || request.taskId !== i.taskId || request.idempotencyKey !== i.idempotencyKey) throw new Error('The Gems task receipt differs from the saved request.');
    const output = amount(result.gems, true);
    if (i.consent && i.consent.output !== output) throw new Error('The task receipt differs from the reviewed reward.');
    return { receiptId, acceptedAt, amount: output, currency: 'GEMS', funding: null, rate: null };
  }
  if (i.kind === 'gems-to-shards' && r.baseId !== i.baseId) throw new Error('The Gems receipt differs from the saved base.');
  const currency = i.kind === 'gems-from-keep' ? 'KEEP' : 'GEMS', input = i.kind === 'gems-from-keep' ? i.keep : i.gems;
  const funding = object(r.funding), output = amount(i.kind === 'gems-from-keep' ? result.gems : result.shards, true), rate = integer(result.rate);
  if (funding.currency !== currency || funding.amount !== input || BigInt(input) * BigInt(rate) !== BigInt(output)) throw new Error('The Gems receipt funding or output differs from the saved request.');
  if (i.consent && (i.consent.rate !== rate || i.consent.output !== output)) throw new Error('The Gems receipt differs from the reviewed rate or output.');
  return { receiptId, acceptedAt, amount: output, currency: i.kind === 'gems-from-keep' ? 'GEMS' : 'SHARDS', funding: { currency, amount: input }, rate };
}
export type GemsOverview = { gems: string; sources: string[]; exactConsent: boolean; minConvertKeep: number; maxConvertKeepPerTx: number;
  gemsPerKeep: number; shardsPerGem: number; tasks: Array<{ id: string; gems: string; claimed: boolean; title: string | null }> };
export function gemsConsent(intent: GemsIntent, overview: GemsOverview): GemsConsent {
  if (intent.kind === 'gems-task-claim') {
    const task = overview.tasks.find(task => task.id === intent.taskId);
    if (!task) throw new Error('This Gems task is unavailable.');
    return { rate: null, output: task.gems };
  }
  const rate = intent.kind === 'gems-from-keep' ? overview.gemsPerKeep : overview.shardsPerGem;
  const input = intent.kind === 'gems-from-keep' ? intent.keep : intent.gems;
  return { rate, output: amount((BigInt(input) * BigInt(rate)).toString(), true) };
}
export function assertGemsConsent(intent: GemsIntent, overview: GemsOverview): void {
  if (!overview.exactConsent) throw new Error('This server cannot guarantee the reviewed Gems output. New requests are unavailable.');
  if (!intent.consent) throw new Error('This saved request has no reviewed output. Check its original receipt; it cannot be resent.');
  const current = gemsConsent(intent, overview);
  if (intent.consent.rate !== current.rate || intent.consent.output !== current.output) throw new Error('The Gems rate or reward changed. The original request cannot be resent with different terms.');
}
export function gemsAvailable(raw: unknown): boolean {
  try { const feature = object(object(object(raw).features).gems); return feature.version === 1 && feature.receipts === 1; } catch { return false; }
}
export function parseGemsOverview(raw: unknown): GemsOverview {
  const r = object(raw);
  if (!gemsAvailable(raw) || !Array.isArray(r.sources) || r.sources.some(v => typeof v !== 'string') || !Array.isArray(r.tasks)) throw new Error('Gems are unavailable on this server.');
  const minConvertKeep = integer(r.minConvertKeep), maxConvertKeepPerTx = integer(r.maxConvertKeepPerTx);
  if (minConvertKeep > maxConvertKeepPerTx) throw new Error('Invalid Gems conversion bounds.');
  timestamp(r.serverNow);
  return { gems: amount(r.gems), sources: r.sources as string[], exactConsent: object(object(r.features).gems).exactConsent === 1, minConvertKeep, maxConvertKeepPerTx,
    gemsPerKeep: integer(r.gemsPerKeep), shardsPerGem: integer(r.shardsPerGem), tasks: r.tasks.map(rawTask => {
      const t = object(rawTask), id = text(t.id);
      if (!/^[a-z0-9_-]{1,64}$/.test(id) || typeof t.claimed !== 'boolean') throw new Error('Invalid Gems task.');
      const gems = typeof t.gems === 'number' ? String(integer(t.gems)) : amount(t.gems, true);
      return { id, gems, claimed: t.claimed, title: t.title === undefined ? null : text(t.title) };
    }) };
}
/** This predicts from one snapshot, never proves a debit. Consent must disclose
 * both full-price options because balances can change before server execution. */
export function gemsSpendFunding(price: string, balances: { gems?: string; keep: string; features?: unknown }): {
  preferred: 'GEMS'; fallback: 'KEEP'; amount: string; expected: 'GEMS' | 'KEEP' | null;
} {
  const cost = BigInt(amount(price, true));
  if (!gemsAvailable(balances)) throw new Error('Refresh Gems capabilities before reviewing this spend.');
  const gems = BigInt(amount(balances.gems)), keep = BigInt(amount(balances.keep));
  return { preferred: 'GEMS', fallback: 'KEEP', amount: price, expected: gems >= cost ? 'GEMS' : keep >= cost ? 'KEEP' : null };
}
