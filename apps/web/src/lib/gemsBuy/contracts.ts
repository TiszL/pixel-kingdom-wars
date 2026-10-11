import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const U64_MAX = 0xffff_ffff_ffff_ffffn;
export const CLASSIC_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export type GemsBuyRequest = { kind: 'gems_buy'; keepIn: number; idempotencyKey: string };
export type GemsBuyBinding = { wallet: string; mint: string; decimals: number };
export type GemsBuyQuote = GemsBuyBinding & { id: string; kind: 'gems_buy'; idempotencyKey: string;
  reference: string; source: string; destination: string; keepIn: number; gemsOut: number; expiresAt: string };
export type GemsBuyReceipt = { version: 1; receiptId: string; acceptedAt: string; wallet: string;
  depositId: string; txSignature: string; funding: { currency: 'KEEP'; amount: string; baseUnits: string };
  result: { currency: 'GEMS'; amount: string; rate: 1 } };
export type GemsBuyDeposit = { status: 'pending' | 'finalized' | 'credited' | 'expired' | 'failed';
  txSignature: string | null; paymentSignature: string | null; amount: string | null;
  createdAt: string; finalizedAt: string | null; keepIn: number; gemsOut: number; dustBaseUnits: string | null;
  keepCredited: string | null; gemsCredited: string | null; receipt: GemsBuyReceipt | null };
export type GemsBuyRecovery = { version: 1; wallet: string; idempotencyKey: string; serverNow: string; recoveryOnly: true; expiredPaymentRecovery?: 1 }
  & ({ status: 'unknown'; deposit: null } | { status: 'known'; deposit: GemsBuyDeposit & { originalIntent: GemsBuyQuote } });
declare const admissionBrand: unique symbol;
/** Only a fresh POST response can obtain this runtime admission. Never serialize it as signing authority. */
export type GemsBuyAdmission = { readonly quote: Readonly<GemsBuyQuote>; readonly serverNow: string;
  readonly status: 'pending'; readonly [admissionBrand]: true };
const admissions = new WeakMap<object, { remaining: number; start: number; startWall: number; last: number; lastWall: number; now: () => number; wall: () => number }>();

function fail(): never { throw new Error('Invalid or mismatched wallet Gems purchase evidence.'); }
function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key))) return fail();
  return r;
}
export function gemsBuyAddress(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 44) return fail();
  try { if (new PublicKey(raw).toBase58() === raw) return raw; } catch { /* refuse below */ }
  return fail();
}
export function gemsBuySignature(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 88) return fail();
  try { const bytes = bs58.decode(raw); if (bytes.length === 64 && bs58.encode(bytes) === raw) return raw; } catch { /* refuse below */ }
  return fail();
}
function uuid(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/.test(raw)) return fail();
  return raw;
}
function timestamp(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
    || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw) return fail();
  return raw;
}
function whole(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) return fail();
  return raw;
}
function units(raw: unknown, positive = false): string {
  if (typeof raw !== 'string' || raw.length > 20 || !/^(0|[1-9][0-9]*)$/.test(raw)
    || BigInt(raw) > U64_MAX || positive && raw === '0') return fail();
  return raw;
}
export function gemsBuySourceAta(wallet: string, mint: string): string {
  const owner = new PublicKey(gemsBuyAddress(wallet));
  if (!PublicKey.isOnCurve(owner.toBytes())) return fail();
  return PublicKey.findProgramAddressSync([owner.toBytes(), CLASSIC_TOKEN_PROGRAM.toBytes(),
    new PublicKey(gemsBuyAddress(mint)).toBytes()], ASSOCIATED_TOKEN_PROGRAM)[0].toBase58();
}
export function parseGemsBuyRequest(raw: unknown): GemsBuyRequest {
  const r = record(raw, ['kind', 'keepIn', 'idempotencyKey']);
  if (r.kind !== 'gems_buy' || typeof r.idempotencyKey !== 'string' || r.idempotencyKey.length < 8 || r.idempotencyKey.length > 128) return fail();
  return { kind: 'gems_buy', keepIn: whole(r.keepIn), idempotencyKey: r.idempotencyKey };
}
const quoteKeys = ['id', 'kind', 'wallet', 'idempotencyKey', 'reference', 'source', 'destination', 'mint', 'decimals', 'keepIn', 'gemsOut', 'expiresAt'];
export function parseGemsBuyQuote(raw: unknown, request: GemsBuyRequest, binding: GemsBuyBinding): GemsBuyQuote {
  const r = record(raw, quoteKeys), intent = parseGemsBuyRequest(request);
  const wallet = gemsBuyAddress(r.wallet), mint = gemsBuyAddress(r.mint), source = gemsBuyAddress(r.source);
  const destination = gemsBuyAddress(r.destination), reference = gemsBuyAddress(r.reference);
  if (r.kind !== 'gems_buy' || wallet !== binding.wallet || mint !== binding.mint || r.idempotencyKey !== intent.idempotencyKey
    || r.keepIn !== intent.keepIn || r.gemsOut !== intent.keepIn || r.decimals !== binding.decimals
    || !Number.isInteger(r.decimals) || (r.decimals as number) < 0 || (r.decimals as number) > 19
    || source !== gemsBuySourceAta(wallet, mint) || new Set([wallet, mint, source, destination, reference]).size !== 5
    || BigInt(intent.keepIn) * 10n ** BigInt(r.decimals as number) > U64_MAX) return fail();
  return { id: uuid(r.id), kind: 'gems_buy', wallet, idempotencyKey: intent.idempotencyKey, reference, source,
    destination, mint, decimals: r.decimals as number, keepIn: intent.keepIn, gemsOut: intent.keepIn, expiresAt: timestamp(r.expiresAt) };
}
export function sameGemsBuyQuote(a: GemsBuyQuote, b: GemsBuyQuote): boolean {
  return quoteKeys.every(key => a[key as keyof GemsBuyQuote] === b[key as keyof GemsBuyQuote]);
}
/** The caller supplies freshly negotiated wallet-keep policy, never a historical saved policy. */
export function parseGemsBuyAdmission(raw: unknown, request: GemsBuyRequest, binding: GemsBuyBinding,
  policy: { destinationAta: string; minConvertKeep: number; maxConvertKeepPerTx: number },
  timing: { requestStartedAt: number; requestStartedWall: number; now?: () => number; wall?: () => number }): GemsBuyAdmission {
  const r = record(raw, [...quoteKeys, 'status', 'serverNow']);
  const { status, serverNow: rawServerNow, ...original } = r;
  const quote = parseGemsBuyQuote(original, request, binding), serverNow = timestamp(rawServerNow);
  const now = timing.now ?? (() => performance.now()), wall = timing.wall ?? (() => Date.now());
  const observedAt = now(), observedWall = wall(), remaining = Date.parse(quote.expiresAt) - Date.parse(serverNow);
  const age = Math.max(observedAt - timing.requestStartedAt, observedWall - timing.requestStartedWall);
  if (status !== 'pending' || quote.destination !== gemsBuyAddress(policy.destinationAta)
    || quote.keepIn < whole(policy.minConvertKeep) || quote.keepIn > whole(policy.maxConvertKeepPerTx)
    || policy.minConvertKeep > policy.maxConvertKeepPerTx || !Number.isFinite(timing.requestStartedAt)
    || timing.requestStartedAt < 0 || !Number.isFinite(timing.requestStartedWall) || !Number.isFinite(observedWall)
    || observedWall < timing.requestStartedWall || !Number.isFinite(observedAt) || observedAt < timing.requestStartedAt || age >= remaining) return fail();
  const admission = Object.freeze({ quote: Object.freeze(quote), status, serverNow }) as GemsBuyAdmission;
  admissions.set(admission, { remaining, start: timing.requestStartedAt, startWall: timing.requestStartedWall, last: observedAt, lastWall: observedWall, now, wall });
  return admission;
}
export function assertGemsBuyAdmissionFresh(admission: GemsBuyAdmission): void {
  const timing = admissions.get(admission), now = timing?.now(), wall = timing?.wall();
  if (!timing || now === undefined || wall === undefined || !Number.isFinite(now) || !Number.isFinite(wall)
    || now < timing.last || wall < timing.lastWall || Math.max(now - timing.start, wall - timing.startWall) >= timing.remaining) {
    throw new Error('This Gems quote is no longer payable. Check its original purchase.');
  }
  timing.last = now; timing.lastWall = wall;
}
const depositKeys = ['status', 'txSignature', 'paymentSignature', 'amount', 'createdAt', 'finalizedAt', 'keepIn', 'gemsOut', 'dustBaseUnits', 'keepCredited', 'gemsCredited', 'receipt'];
function parseDisclosure(raw: unknown, quote: GemsBuyQuote): GemsBuyDeposit {
  const r = record(raw, depositKeys), unit = 10n ** BigInt(quote.decimals);
  if (!['pending', 'finalized', 'credited', 'expired', 'failed'].includes(r.status as string)
    || r.keepIn !== quote.keepIn || r.gemsOut !== quote.gemsOut) return fail();
  const amount = r.amount === null ? null : units(r.amount), dustBaseUnits = r.dustBaseUnits === null ? null : units(r.dustBaseUnits);
  if (dustBaseUnits !== (amount === null ? null : (BigInt(amount) % unit).toString())) return fail();
  const txSignature = r.txSignature === null ? null : gemsBuySignature(r.txSignature);
  const paymentSignature = r.paymentSignature === null ? null : gemsBuySignature(r.paymentSignature);
  const createdAt = timestamp(r.createdAt), finalizedAt = r.finalizedAt === null ? null : timestamp(r.finalizedAt);
  if (Date.parse(quote.expiresAt) <= Date.parse(createdAt) || finalizedAt !== null && Date.parse(finalizedAt) < Date.parse(createdAt)) return fail();
  let receipt: GemsBuyReceipt | null = null;
  let keepCredited: string | null = null, gemsCredited: string | null = null;
  if (r.status === 'credited') {
    const p = record(r.receipt, ['version', 'receiptId', 'acceptedAt', 'wallet', 'depositId', 'txSignature', 'funding', 'result']);
    const funding = record(p.funding, ['currency', 'amount', 'baseUnits']), result = record(p.result, ['currency', 'amount', 'rate']);
    keepCredited = units(r.keepCredited, true); gemsCredited = units(r.gemsCredited, true);
    const acceptedAt = timestamp(p.acceptedAt);
    if (amount === null || txSignature === null || finalizedAt === null || p.version !== 1 || p.wallet !== quote.wallet
      || p.depositId !== quote.id || p.txSignature !== txSignature || funding.currency !== 'KEEP' || result.currency !== 'GEMS'
      || units(funding.baseUnits, true) !== amount || units(funding.amount, true) !== keepCredited || units(result.amount, true) !== gemsCredited
      || BigInt(amount) / unit !== BigInt(keepCredited) || gemsCredited !== keepCredited || result.rate !== 1
      || Date.parse(acceptedAt) < Date.parse(createdAt)) return fail();
    receipt = { version: 1, receiptId: uuid(p.receiptId), acceptedAt, wallet: quote.wallet, depositId: quote.id, txSignature,
      funding: { currency: 'KEEP', amount: keepCredited, baseUnits: amount }, result: { currency: 'GEMS', amount: gemsCredited, rate: 1 } };
  } else if (r.receipt !== null || r.keepCredited !== null || r.gemsCredited !== null) return fail();
  return { status: r.status as GemsBuyDeposit['status'], txSignature, paymentSignature, amount, createdAt, finalizedAt,
    keepIn: quote.keepIn, gemsOut: quote.gemsOut, dustBaseUnits, keepCredited, gemsCredited, receipt };
}
export function parseGemsBuyDeposit(raw: unknown, quote: GemsBuyQuote): GemsBuyDeposit {
  const r = record(raw, ['id', 'kind', 'reference', ...depositKeys]);
  const { id, kind, reference, ...disclosure } = r;
  if (id !== quote.id || kind !== 'gems_buy' || reference !== quote.reference) return fail();
  return parseDisclosure(disclosure, quote);
}
export function parseGemsBuyRecovery(raw: unknown, request: GemsBuyRequest, binding: GemsBuyBinding, originalQuote?: GemsBuyQuote): GemsBuyRecovery {
  const marker = !!raw && typeof raw === 'object' && Object.hasOwn(raw, 'expiredPaymentRecovery');
  const r = record(raw, ['version', 'wallet', 'idempotencyKey', 'serverNow', 'recoveryOnly', 'status', 'deposit', ...(marker ? ['expiredPaymentRecovery'] : [])]);
  const intent = parseGemsBuyRequest(request), serverNow = timestamp(r.serverNow);
  if (r.version !== 1 || r.wallet !== binding.wallet || r.idempotencyKey !== intent.idempotencyKey || r.recoveryOnly !== true || marker && r.expiredPaymentRecovery !== 1) return fail();
  const envelope = { version: 1 as const, wallet: binding.wallet, idempotencyKey: intent.idempotencyKey, serverNow, recoveryOnly: true as const,
    ...(marker ? { expiredPaymentRecovery: 1 as const } : {}) };
  if (r.status === 'unknown' && r.deposit === null) return { ...envelope, status: 'unknown', deposit: null };
  if (r.status !== 'known') return fail();
  const d = record(r.deposit, ['originalIntent', ...depositKeys]), { originalIntent: rawQuote, ...disclosure } = d;
  const originalIntent = parseGemsBuyQuote(rawQuote, intent, binding);
  if (originalQuote && !sameGemsBuyQuote(originalQuote, originalIntent)) return fail();
  return { ...envelope, status: 'known', deposit: { originalIntent, ...parseDisclosure(disclosure, originalIntent) } };
}
