/**
 * Usernames (owner 2026-07-29).
 *
 * `players.name` had NO uniqueness of any kind — two accounts could carry the
 * same display name, and one could rename INTO another's name mid-tournament.
 * On a map where names label raid targets and item-market sellers, that is free
 * impersonation. `clans.name` has been UNIQUE since day one; this brings
 * players in line.
 *
 * Uniqueness is enforced by the DB (`players_name_key_uq`), never by a
 * check-then-write — two players typing the same name in the same instant is a
 * real race, and only the index closes it.
 */
import { SEEKER, USERNAMES } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { players } from '../db/schema';
import { HttpError } from '../lib/errors';
import {
  identityValleysForWallet, publishWorldIdentityAfterCommit,
} from './worldIdentity';

const PATTERN = new RegExp(USERNAMES.pattern);
const SKR_LABEL = new RegExp(USERNAMES.skrLabelPattern);
const SKR_TLD: string = SEEKER.skr.tld;

/**
 * Names nobody may self-assign. System words (an "ADMIN" in the raid log is a
 * phishing surface) plus the game's own names. Static data, not a game number,
 * so it lives here rather than in @shardkeep/shared.
 */
const RESERVED = new Set([
  'admin', 'administrator', 'mod', 'moderator', 'support', 'staff', 'system',
  'root', 'owner', 'official', 'shardkeep', 'pixelkingdomwars', 'bandits',
  'deleted', 'null', 'undefined', 'anonymous', 'seeker', 'solana',
]);

/** Why a name was rejected — mirrored to the client so the UI can explain. */
export type UsernameReason = 'length' | 'charset' | 'reserved' | 'taken';

/** Case-folded uniqueness key. The ONLY place this fold is defined. */
export function usernameKey(name: string): string {
  return name.trim().normalize('NFKC').toLowerCase();
}

/**
 * Validate a SELF-CHOSEN name. Returns the reason it fails, or null.
 *
 * Note the charset bans dots — that is deliberate: it makes a self-chosen name
 * structurally incapable of colliding with a verified `x.skr`, so no one can
 * hand-type their way into looking like a Seeker's domain name.
 */
export function checkUsernameFormat(raw: string): UsernameReason | null {
  const name = raw.trim().normalize('NFKC');
  if (name.length < USERNAMES.minLen || name.length > USERNAMES.maxLen) return 'length';
  if (!PATTERN.test(name)) return 'charset';
  if (RESERVED.has(usernameKey(name))) return 'reserved';
  return null;
}

/**
 * Validate an adopted `x.skr` name. Returns the reason it fails, or null.
 *
 * A domain being PROVEN on-chain says who owns it — it does not say the name is
 * safe to print next to a VERIFIED SEEKER badge. `.skr` is a commercial
 * namespace: `support.skr` is purchasable, and ANS permits 63-character labels.
 * So the adoption path gets the SAME reserved list and the SAME character class
 * as a self-chosen name; only the length floor and the one dot are relaxed
 * (security review F1 — this path previously skipped every check).
 */
export function checkSkrUsernameFormat(raw: string): UsernameReason | null {
  const name = raw.trim().normalize('NFKC').toLowerCase();
  if (!name.endsWith(SKR_TLD)) return 'charset';
  if (name.length > USERNAMES.skrMaxLen) return 'length';
  const label = name.slice(0, -SKR_TLD.length);
  if (!SKR_LABEL.test(label)) return 'charset';
  // Both halves: `support.skr` impersonates through the LABEL, and the fully
  // qualified name is what actually renders, so neither may be a reserved word.
  if (RESERVED.has(label) || RESERVED.has(name)) return 'reserved';
  return null;
}

/** Days remaining on the rename cooldown; 0 when a rename is allowed now. */
export function cooldownDaysLeft(nameChangedAt: Date | null, now: Date): number {
  if (!nameChangedAt) return 0;
  const ms = USERNAMES.changeCooldownDays * 86_400_000 - (now.getTime() - nameChangedAt.getTime());
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

/** Is this key free? Advisory only — the write still relies on the index. */
export async function isUsernameFree(db: Db, key: string): Promise<boolean> {
  const [row] = await db.select({ w: players.wallet }).from(players).where(eq(players.nameKey, key)).limit(1);
  return !row;
}

/** `GET /username/check` — advisory availability for the settings UI. */
export async function checkUsername(db: Db, raw: string): Promise<{
  available: boolean; normalized: string; reason?: UsernameReason;
}> {
  const normalized = raw.trim().normalize('NFKC');
  const bad = checkUsernameFormat(normalized);
  if (bad) return { available: false, normalized, reason: bad };
  const free = await isUsernameFree(db, usernameKey(normalized));
  return free ? { available: true, normalized } : { available: false, normalized, reason: 'taken' };
}

export interface SetUsernameOpts {
  /** 'skr' swaps the self-chosen rules for the `.skr` ones (the domain carries a
   *  dot, and may be shorter than minLen) and skips the cooldown: the name was
   *  PROVEN on-chain, it isn't a free-form pick. It does NOT skip validation —
   *  reserved words and the character class apply to both. */
  source?: 'user' | 'skr';
  now?: Date;
}

/**
 * Set the player's username. Enforces format, reserved words, the rename
 * cooldown, and — via the unique index — case-insensitive uniqueness.
 *
 * @throws {HttpError} 400 format · 409 taken/reserved · 422 cooldown
 */
export async function setUsername(
  db: Db, wallet: string, raw: string, opts: SetUsernameOpts = {},
): Promise<{ name: string; nameChangedAt: Date }> {
  const source = opts.source ?? 'user';
  const now = opts.now ?? new Date();
  const name = raw.trim().normalize('NFKC');

  // EVERY path validates. The `.skr` rules differ from the self-chosen ones,
  // they are not absent: an on-chain proof of ownership is not a licence to
  // wear 'support.skr' next to a verified badge (security review F1).
  const bad = source === 'skr' ? checkSkrUsernameFormat(name) : checkUsernameFormat(name);
  if (bad === 'length') {
    throw new HttpError(400, source === 'skr'
      ? `that domain is longer than ${USERNAMES.skrMaxLen} characters`
      : `name must be ${USERNAMES.minLen}–${USERNAMES.maxLen} characters`);
  }
  if (bad === 'charset') {
    throw new HttpError(400, source === 'skr'
      ? 'that is not a well-formed .skr domain'
      : 'name may use letters, numbers, _ and - only, starting and ending alphanumeric');
  }
  if (bad === 'reserved') throw new HttpError(409, 'that name is reserved');

  const [current] = await db
    .select({ name: players.name, nameKey: players.nameKey, nameChangedAt: players.nameChangedAt })
    .from(players).where(eq(players.wallet, wallet));
  if (!current) throw new HttpError(401, 'unknown player');

  const key = usernameKey(name);
  // Re-saving the same name is a no-op, not a cooldown burn.
  if (key === current.nameKey) return { name: current.name, nameChangedAt: current.nameChangedAt ?? now };
  const identityValleyIds = await identityValleysForWallet(db, wallet);

  if (source === 'user') {
    const left = cooldownDaysLeft(current.nameChangedAt, now);
    // 422, not 400: the request is well-formed, the ACCOUNT isn't eligible yet.
    if (left > 0) throw new HttpError(422, `you can change your name again in ${left} day${left === 1 ? '' : 's'}`);
  }

  try {
    // A `.skr` adoption does NOT start the rename cooldown. The player never
    // chose this name — we assigned it from their verified domain — so charging
    // them their one rename for it is backwards, and it produced a UI that
    // promised "changing it replaces it with a name you pick" while the server
    // answered "you can change your name again in 30 days" (verified in the
    // browser 2026-07-29). Adoption skips the cooldown CHECK already; it must
    // skip the STAMP for the same reason.
    const stamp = source === 'user' ? { nameChangedAt: now } : {};
    await db.update(players).set({ name, nameKey: key, ...stamp }).where(eq(players.wallet, wallet));
  } catch (e) {
    // 23505 = unique_violation on players_name_key_uq. This is the ONLY correct
    // place to learn a name is taken: a prior SELECT would race.
    // drizzle wraps driver errors, so unwrap `.cause` too (clans.ts convention).
    const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    const msg = e instanceof Error ? e.message : '';
    if (code === '23505' || msg.includes('players_name_key_uq')) {
      throw new HttpError(409, 'that name is already taken');
    }
    throw e;
  }
  await publishWorldIdentityAfterCommit(db, wallet, identityValleyIds);
  return { name, nameChangedAt: source === 'user' ? now : (current.nameChangedAt ?? now) };
}

/**
 * Adopt a verified `.skr` as the username, best-effort.
 *
 * Used right after a Seeker link. NEVER throws: a Seeker whose domain name is
 * already taken, malformed, over-length or RESERVED must still end up linked and
 * badged — they just pick a name by hand. A rejected domain adopts NOTHING;
 * degrading to "pick a name" is the only acceptable failure mode, degrading to a
 * bad name is not (security review F1). Returns the adopted name, or null.
 */
export async function adoptSkrUsername(db: Db, wallet: string, domain: string): Promise<string | null> {
  try {
    const [cur] = await db.select({ nameKey: players.nameKey }).from(players).where(eq(players.wallet, wallet));
    // Never overwrite a name the player already chose — their identity, their call.
    if (!cur || cur.nameKey !== '') return null;
    const res = await setUsername(db, wallet, domain, { source: 'skr' });
    return res.name;
  } catch {
    return null;
  }
}
