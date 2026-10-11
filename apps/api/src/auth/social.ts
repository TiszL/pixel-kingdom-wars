/** Privy's signed identity is authoritative; the client never names a wallet.
 * https://docs.privy.io/user-management/users/identity-tokens */
import bs58 from 'bs58';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../config';
import { HttpError } from '../lib/errors';

export type SocialTokenVerifier = (accessToken: string, identityToken: string) => Promise<{
  subject: string; wallet: string;
}>;

export function makeSocialTokenVerifier(config: Config, key?: JWTVerifyGetKey): SocialTokenVerifier {
  const verifierKey = key ?? (config.PRIVY_JWKS_URL
    ? createRemoteJWKSet(new URL(config.PRIVY_JWKS_URL), { timeoutDuration: 5_000 }) : null);
  return async (accessToken, identityToken) => {
    if (!config.PRIVY_APP_ID || !verifierKey) {
      throw new HttpError(503, 'social sign-in is temporarily unavailable');
    }
    try {
      const options = {
        algorithms: ['ES256'], issuer: 'privy.io', audience: config.PRIVY_APP_ID,
        requiredClaims: ['sub', 'iat', 'exp'],
      };
      const [{ payload: access }, { payload: identity }] = await Promise.all([
        jwtVerify(accessToken, verifierKey, options),
        jwtVerify(identityToken, verifierKey, options),
      ]);
      if (!access.sub?.startsWith('did:privy:') || identity.sub !== access.sub
          || typeof access['sid'] !== 'string' || !access['sid']
          // Identity tokens may also carry sid but live longer. Never accept
          // the signed user-data token in place of a current access token.
          || access['linked_accounts'] !== undefined
          || (identity['sid'] !== undefined && identity['sid'] !== access['sid'])
          || typeof identity['linked_accounts'] !== 'string') throw new Error('identity mismatch');
      const linked: unknown = JSON.parse(identity['linked_accounts']);
      if (!Array.isArray(linked)) throw new Error('invalid linked accounts');
      const embedded = linked.filter((account: unknown) => {
        if (!account || typeof account !== 'object') return false;
        const a = account as Record<string, unknown>;
        return a['type'] === 'wallet' && a['chain_type'] === 'solana'
          // Privy's signed lightweight wallet omits connector_type. Its own
          // identity-token parser derives embedded from wallet_client_type=privy
          // (@privy-io/node 0.34.0, src/lib/identity-token.ts). An explicitly
          // conflicting connector still fails closed; client fields never enter.
          && a['wallet_client_type'] === 'privy'
          && (a['connector_type'] === undefined || a['connector_type'] === 'embedded');
      }) as Array<Record<string, unknown>>;
      // Do not choose by array order, a request field, or an external wallet.
      if (embedded.length !== 1 || typeof embedded[0]!['address'] !== 'string') {
        throw new Error('missing or ambiguous embedded wallet');
      }
      const wallet = embedded[0]!['address'];
      if (bs58.decode(wallet).length !== 32) throw new Error('invalid Solana wallet');
      return { subject: access.sub, wallet };
    } catch {
      // Never log either bearer token or linked email/account metadata.
      throw new HttpError(401, 'social identity could not be verified — sign in again', 'SOCIAL_IDENTITY_INVALID');
    }
  };
}
