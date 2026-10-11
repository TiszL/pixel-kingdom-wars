/** K-night-03 fixture: a TypeScript port of the native client's SKR faucet read decoders, written from the Android
 * sources (read-only, 2026-10-06):
 *   network/src/main/kotlin/gg/pixelkingdomwars/nativeclient/model/SkrFaucet.kt
 *     SkrFaucetAttempt.from, SkrFaucetGrant.from, SkrFaucetGrantPage.from and the private skr* readers
 *   network/src/main/kotlin/gg/pixelkingdomwars/nativeclient/workshop/WorkshopProtocol.kt  wallet()
 *   app/src/main/kotlin/gg/pixelkingdomwars/nativeclient/data/SkrFaucetRepository.kt
 *     checkGrant / amount and readDiscoveryPage's page checks
 * Each `need` stands where the Kotlin `require`/`requireNotNull` stands; an answer this refuses is one the phone turns
 * into ApiCompatibilityException ("/devnet-skr-faucet/grants"), keeping its saved claim evidence and refusing to act.
 * The Kotlin source is the contract: change this only to follow it. */

type Obj = Record<string, unknown>;
function need(ok: unknown, why: string): asserts ok { if (!ok) throw new Error(`native decoder refused: ${why}`); }
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

// skrText: a present, non-empty JSON string. skrNullableText / skrNullableObject: an explicit JSON null is null, but an
// ABSENT key is not (Kotlin `get(key) == JsonNull` is false for a missing key), so every nullable field must be sent.
function text(raw: Obj, key: string): string { const value = raw[key]; need(typeof value === 'string' && value.length > 0, `${key} text`); return value; }
const nullableText = (raw: Obj, key: string) => raw[key] === null ? null : text(raw, key);
function nullableObject(raw: Obj, key: string): Obj | null { const value = raw[key]; if (value === null) return null; need(isObj(value), `${key} object`); return value; }
// skrInt: a JSON number (never a string) that fits a Kotlin Int.
function int(raw: Obj, key: string): number {
  const value = raw[key]; need(typeof value === 'number' && Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31, `${key} int`); return value;
}
// UUID.fromString(it).toString() == it: canonical lowercase only.
function uuid(value: string): string { need(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value), 'canonical uuid'); return value; }
function amount(value: string, positive = false): string {
  need((positive ? /^[1-9][0-9]{0,19}$/ : /^(0|[1-9][0-9]{0,19})$/).test(value) && BigInt(value) <= (1n << 64n) - 1n, 'u64 decimal string');
  return value;
}
function instant(value: string): number {
  need(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value) && !Number.isNaN(Date.parse(value)), 'ISO instant'); return Date.parse(value);
}
function wallet(value: string): void {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  need(value.length >= 32 && value.length <= 44, 'address length');
  let n = 0n;
  for (const character of value) { const digit = alphabet.indexOf(character); need(digit >= 0, 'base58'); n = n * 58n + BigInt(digit); }
  const bytes = n === 0n ? 0 : Math.ceil(n.toString(2).length / 8);
  need(bytes + value.match(/^1*/u)![0].length === 32, '32-byte address');
}
interface Value { raw: string; known: boolean }
function enumValue(raw: Obj, key: string, known: readonly string[]): Value { const value = text(raw, key); return { raw: value, known: known.includes(value) }; }

export const NATIVE_ATTEMPT_PHASES = ['prepared', 'player_signed', 'submitted', 'finalized', 'failed', 'expired', 'abandoned'] as const;
export const NATIVE_GRANT_STATUSES = ['requested', 'sent', 'failed'] as const;
export interface NativeGrant { id: string; status: Value; mint: string; decimals: number; amountRaw: string; requestedAtMs: number; attempt: { id: string; phase: Value } | null }

export function nativeAttempt(raw: Obj) {
  const signature = nullableText(raw, 'signature');
  if (signature !== null) need(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature), 'signature');
  return { id: uuid(text(raw, 'id')), phase: enumValue(raw, 'phase', NATIVE_ATTEMPT_PHASES),
    signature, lastValidBlockHeight: amount(text(raw, 'lastValidBlockHeight'), true) };
}
export function nativeGrant(raw: unknown): NativeGrant {
  need(isObj(raw), 'grant object');
  const mint = text(raw, 'mint'); wallet(mint);
  const decimals = int(raw, 'decimals'); need(decimals >= 0 && decimals <= 255, 'decimals range');
  const sentAt = nullableText(raw, 'sentAt'); if (sentAt !== null) instant(sentAt);
  const status = enumValue(raw, 'status', NATIVE_GRANT_STATUSES);
  const attemptRaw = nullableObject(raw, 'attempt'); const attempt = attemptRaw === null ? null : nativeAttempt(attemptRaw);
  if (status.known && status.raw === 'sent') need(sentAt !== null, 'sent grant has sentAt');
  nullableText(raw, 'error');
  return { id: uuid(text(raw, 'id')), status, mint, decimals, amountRaw: amount(text(raw, 'amountRaw'), true),
    requestedAtMs: instant(text(raw, 'requestedAt')), attempt };
}
/** SkrFaucetGrantPage.from(raw, maxItems): the outer key set is exact. */
export function nativeGrantPage(raw: unknown, maxItems: number) {
  need(maxItems > 0 && isObj(raw), 'page object');
  const keys = Object.keys(raw).sort();
  need(keys.length === 2 && keys[0] === 'items' && keys[1] === 'nextCursor', `page keys exactly {items,nextCursor}, got ${keys.join(',')}`);
  need(Array.isArray(raw.items), 'items array'); need(raw.items.length <= maxItems, 'page within cap');
  const items = raw.items.map(nativeGrant);
  need(new Set(items.map((item) => item.id)).size === items.length, 'distinct ids');
  const cursorText = nullableText(raw, 'nextCursor'); const nextCursor = cursorText === null ? null : uuid(cursorText);
  need(nextCursor === null || items[items.length - 1]?.id === nextCursor, 'cursor is the last item');
  return { items, nextCursor };
}
/** SkrFaucetRepository.checkGrant: the grant is exactly the pinned identity and the catalogue grant. */
export function nativeCheckGrant(grant: NativeGrant, pin: { mint: string; decimals: number }, grantSkr: number) {
  const expected = BigInt(grantSkr) * 10n ** BigInt(pin.decimals);
  need(expected > 0n && expected.toString(2).length <= 64, 'grant amount bound');
  need(grant.mint === pin.mint && grant.decimals === pin.decimals && grant.amountRaw === expected.toString(), 'faucet token identity');
}
/** SkrFaucetRepository.readDiscoveryPage, applied to pages read head-to-tail by following nextCursor. */
export function nativeDiscoveryScan(pages: unknown[], cap: number, pin: { mint: string; decimals: number }, grantSkr: number) {
  const accepted: Array<ReturnType<typeof nativeGrantPage>> = [];
  for (const raw of pages) {
    const page = nativeGrantPage(raw, cap);
    need(page.items.every((item) => item.status.known && item.status.raw === 'requested' && item.attempt?.phase.known !== false), 'only requested grants, known phases');
    for (const item of page.items) nativeCheckGrant(item, pin, grantSkr);
    need(page.nextCursor === null || page.items.length === cap, 'a cursor only on a full page');
    const earlier = accepted.flatMap((prior) => prior.items), seen = new Set(earlier.map((item) => item.id));
    need(page.items.every((item) => !seen.has(item.id)), 'no repeated grant');
    need(page.nextCursor === null || accepted.every((prior) => prior.nextCursor !== page.nextCursor), 'no cursor loop');
    const ordered = [...earlier.slice(-1), ...page.items];
    for (let index = 1; index < ordered.length; index++) {
      const newer = ordered[index - 1]!, older = ordered[index]!;
      need(newer.requestedAtMs > older.requestedAtMs || newer.requestedAtMs === older.requestedAtMs && newer.id > older.id, 'newest first');
    }
    accepted.push(page);
  }
  return accepted;
}
