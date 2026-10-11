import { randomUUID } from 'node:crypto';
import { LOGIN_AUTH } from '@shardkeep/shared';
import { and, eq, gt, isNull, ne, notExists } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { Config } from '../config';
import { multiBaseEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { players, sessions } from '../db/schema';
import { hasActivePaidStableBase } from '../game/baseOwnership';
import { HttpError } from '../lib/errors';
import { lockWithdrawalWalletTx } from '../money/withdrawalLock';
import {
  issueLoginJwt, issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC,
  type SessionIdentity,
} from './session';
import { totpRecoveryProtectionTx } from './totpRecoveryPolicy';
import { verifyWithdrawal2faTx } from './twofa';

export interface LoginSession {
  wallet: string; sessionId: string; loginRequired: boolean; entryPaid: boolean; expiresAt: Date;
}

/** Caller owns the wallet lock and (for SIWS) consumes its nonce in this same
 * transaction. Neither social login nor SIWS creates an unadmitted game base. */
export async function insertLoginSessionTx(
  tx: DbTx, wallet: string, client?: 'browser' | 'solana-mobile',
): Promise<LoginSession> {
  await lockWithdrawalWalletTx(tx, wallet);
  await tx.insert(players).values({ wallet }).onConflictDoNothing();
  if (client) {
    await tx.update(players).set({ firstClient: client }).where(and(
      eq(players.wallet, wallet), isNull(players.firstClient),
      notExists(tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.wallet, wallet))),
    ));
  }
  const [player] = await tx.select().from(players).where(eq(players.wallet, wallet));
  if (!player) throw new Error('login player missing');
  const loginRequired = player.loginTotpRequired;
  const expiresAt = new Date(Date.now() + (loginRequired ? LOGIN_AUTH.pendingTtlSec : SESSION_TTL_SEC) * 1_000);
  const sessionId = randomUUID();
  await tx.insert(sessions).values({
    id: sessionId, wallet, client: client ?? null, expiresAt,
    scope: loginRequired ? 'login_pending' : 'full',
  });
  const entryPaid = !loginRequired && (multiBaseEnabled()
    ? await hasActivePaidStableBase(tx, wallet) : !!player.entryPaidAt);
  return { wallet, sessionId, loginRequired, entryPaid, expiresAt };
}

export async function sendLoginSession(reply: FastifyReply, config: Config, session: LoginSession) {
  const { wallet, sessionId, loginRequired, entryPaid, expiresAt } = session;
  const jwt = loginRequired ? await issueLoginJwt(config, wallet, sessionId)
    : await issueSessionJwt(config, wallet, sessionId);
  reply.clearCookie(loginRequired ? SESSION_COOKIE : LOGIN_COOKIE, { path: '/' });
  reply.setCookie(loginRequired ? LOGIN_COOKIE : SESSION_COOKIE, jwt, {
    httpOnly: true, sameSite: 'lax', secure: config.NODE_ENV === 'production', path: '/',
    maxAge: loginRequired ? LOGIN_AUTH.pendingTtlSec : SESSION_TTL_SEC,
  });
  reply.header('Cache-Control', 'no-store');
  return loginRequired ? { wallet, loginRequired: true, expiresAt: expiresAt.toISOString() }
    : { wallet, entryPaid };
}

export async function completeLogin(db: Db, identity: SessionIdentity, code: string): Promise<LoginSession> {
  const result = await db.transaction(async (tx) => {
    await lockWithdrawalWalletTx(tx, identity.wallet);
    const [pending] = await tx.select().from(sessions).where(and(
      eq(sessions.id, identity.sessionId), eq(sessions.wallet, identity.wallet),
      eq(sessions.scope, 'login_pending'), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()),
    )).for('update');
    if (!pending) throw new HttpError(401, 'login verification expired — sign in again', 'LOGIN_EXPIRED');
    const [player] = await tx.select().from(players).where(eq(players.wallet, identity.wallet));
    if (!player?.loginTotpRequired || player.totpReenrollmentRequired) {
      throw new HttpError(409, 'finish replacement authenticator setup before signing in');
    }
    // A false result must COMMIT its shared lockout counter. Never throw from
    // inside the transaction after an incorrect code.
    if (!await verifyWithdrawal2faTx(tx, identity.wallet, 'totp', code)) return null;
    const now = new Date();
    await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, pending.id));
    const sessionId = randomUUID();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SEC * 1_000);
    await tx.insert(sessions).values({
      id: sessionId, wallet: identity.wallet, client: pending.client,
      scope: 'full', loginMfaAt: now, expiresAt,
    });
    const entryPaid = multiBaseEnabled()
      ? await hasActivePaidStableBase(tx, identity.wallet) : !!player.entryPaidAt;
    return { wallet: identity.wallet, sessionId, expiresAt, entryPaid, loginRequired: false };
  });
  if (!result) throw new HttpError(422, 'invalid or already used authenticator code');
  return result;
}

export async function setLoginProtection(
  db: Db, identity: SessionIdentity, enabled: boolean, code: string, recoveryAvailable: boolean,
): Promise<void> {
  const ok = await db.transaction(async (tx) => {
    await lockWithdrawalWalletTx(tx, identity.wallet);
    const [current] = await tx.select().from(sessions).where(and(
      eq(sessions.id, identity.sessionId), eq(sessions.wallet, identity.wallet),
      eq(sessions.scope, 'full'), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()),
    ));
    if (!current) throw new HttpError(401, 'sign in again before changing login protection');
    const recovery = await totpRecoveryProtectionTx(tx, identity.wallet);
    if (recovery.pending || recovery.holding || recovery.reenrollmentRequired) {
      throw new HttpError(409, 'finish authenticator recovery before changing login protection');
    }
    const [player] = await tx.select().from(players).where(eq(players.wallet, identity.wallet));
    if (!player?.totpEnabled || !player.totpSecret) throw new HttpError(409, 'verify a PKW authenticator first');
    if (enabled && (!player.emailVerified || !player.email || !recoveryAvailable)) {
      throw new HttpError(409, 'login protection needs a verified recovery email and available recovery service');
    }
    if (!await verifyWithdrawal2faTx(tx, identity.wallet, 'totp', code)) return false;
    const now = new Date();
    await tx.update(players).set({ loginTotpRequired: enabled }).where(eq(players.wallet, identity.wallet));
    await tx.update(sessions).set({ loginMfaAt: now }).where(eq(sessions.id, identity.sessionId));
    // Policy changes cannot leave old full or limited credentials usable.
    await tx.update(sessions).set({ revokedAt: now }).where(and(
      eq(sessions.wallet, identity.wallet), ne(sessions.id, identity.sessionId), isNull(sessions.revokedAt),
    ));
    return true;
  });
  if (!ok) throw new HttpError(422, 'invalid or already used authenticator code');
}
