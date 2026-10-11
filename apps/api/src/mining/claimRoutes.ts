/** Player-owned intents and read-only recovery. No verifier/owner DB is wired
 * into this module; terminal receipts come from the separate trusted verifier. */
import { PublicKey } from '@solana/web3.js';
import { TOKEN, TWOFA } from '@shardkeep/shared';
import { MiningClaimPrepareRequestSchema, MiningClaimSubmitRequestSchema, MiningClaimReviewSchema, MiningClaimContinuationRequestSchema, MiningClaimContinuationEnvelopeSchema } from '@shardkeep/shared/miningClaimsApi';
import type { MiningClaimSnapshotReader, MiningClaimSnapshotTrust } from '@shardkeep/chain/mining-claim-snapshot';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { phaseEMiningEnabled } from '../config';
import { createMiningClaimPreparer, MiningClaimPreparationError, type MiningClaimQuoteReader } from './claimPreparation';
import { getMiningClaimPreparation } from './claimPreparationStore';
import { createMiningClaimReader, type MiningClaimStatus } from './claimStatus';
import { acceptMiningClaimSigned, getMiningClaimSigned, MiningClaimSignedStoreError } from './claimSignedStore';
import {createMiningClaimReview} from './claimReview';
import {MiningClaimAdmissionError} from './claimAdmission';
import {createMiningClaimContinuation,getMiningClaimContinuation,MiningClaimContinuationError} from './claimContinuation';
import { getMiningClaimFailure } from './claimFailure';
import { getMiningClaimSettlement } from './claimSettlement';
import { createMiningClaimReconciler, type MiningClaimTransport } from './claimReconcile';
import { toMiningClaimStatusView, toMiningClaimPreparationView, toMiningClaimPreparationEnvelope, toMiningClaimView } from './claimHttpView';

export interface MiningClaimsProvider {
  reader: MiningClaimSnapshotReader;
  trust: MiningClaimSnapshotTrust;
  quoteSource: (signal: AbortSignal) => MiningClaimQuoteReader;
  transport: (signal: AbortSignal) => MiningClaimTransport;
  ordered?: {address:string;dataSha256:string};
  now?: () => Date;
  timeoutMs?: number;
}
function refused(error: unknown): never {
  if (error instanceof MiningClaimAdmissionError || error instanceof MiningClaimContinuationError) {
    const client=['INVALID_INPUT','NOT_FOUND','NOT_PREPARED'].includes(error.code);
    throw new HttpError(client?400:409,'The original claim is held; retain its saved request',`MINING_CLAIM_${error.code}`);
  }
  if (error instanceof MiningClaimPreparationError) {
    if (error.code === 'INVALID_INPUT') throw new HttpError(400, 'Invalid claim request', 'INVALID_INPUT');
    if (error.code === 'FORMAT_UNAVAILABLE') throw new HttpError(503,'Ordered mining claims are unavailable','MINING_CLAIM_FORMAT_UNAVAILABLE');
    if (error.code === 'DISABLED') throw new HttpError(503, 'Mining claims are paused', 'PHASE_E_DISABLED');
    if (error.code === 'INSUFFICIENT_SOL') throw new HttpError(422, 'SOL is required for claim fees and account rent', 'INSUFFICIENT_SOL');
    if (error.code === 'CLAIM_BLOCKHASH_REUSED') throw new HttpError(409, 'A newly observed blockhash is required before preparing again', 'CLAIM_BLOCKHASH_REUSED');
    if (error.code === 'CLAIM_NOT_READY') throw new HttpError(409, 'The allocation is not ready to claim', 'CLAIM_ROOT_PENDING');
    throw new HttpError(503, 'Claim preparation is unavailable; check the saved request', 'CLAIM_UNAVAILABLE');
  }
  if (error instanceof MiningClaimSignedStoreError) {
    if (error.code === 'INVALID_INPUT' || error.code === 'INVALID_WIRE') throw new HttpError(422, 'The signature does not match the saved claim', 'PAYMENT_INSTRUCTIONS_REJECTED');
    if (error.code === 'NOT_FOUND') throw new HttpError(409, 'No claim preparation belongs to this wallet', 'CLAIM_UNKNOWN');
    if (error.code === 'SIGNED_CONFLICT') throw new HttpError(409, 'The original signed claim is already retained', 'CLAIM_SIGNED_CONFLICT');
    throw new HttpError(503, 'The saved claim cannot currently be verified', 'CLAIM_UNAVAILABLE');
  }
  throw error;
}
export function registerMiningClaimRoutes(app: FastifyInstance, db: Db, provider?: MiningClaimsProvider | null): void {
  // Factories are registration-scoped, preserving their bounded pending fences.
  const reader = provider ? createMiningClaimReader(db, provider) : null;
  const prepare = provider ? createMiningClaimPreparer(db, provider) : null;
  const review = provider ? createMiningClaimReview(db,provider) : null;
  const continuation = provider ? createMiningClaimContinuation(db,provider) : null;
  const relay = provider ? createMiningClaimReconciler(db, { mode: 'read-saved-receipt',
    admission: { reader: provider.reader, trust: provider.trust }, transport: provider.transport,
    ...(provider.now ? { now: provider.now } : {}), ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs }) }) : null;
  const identity = provider ? { programId: new PublicKey(provider.trust.programId.toBytes()).toBase58(), keepMint: new PublicKey(provider.trust.keepMint.toBytes()).toBase58(),...(provider.ordered?{ordered:1 as const}:{}) } : undefined;
  const clock = provider?.now ?? (() => new Date());
  const serverNow = () => clock().toISOString();
  const auth = { preHandler: [app.authenticate] };
  const noStore = async (_request: unknown, reply: { header: (name: string, value: string) => unknown }, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store'); return payload;
  };
  const post = { ...auth, onSend: noStore, bodyLimit: 4096,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } } };
  app.get('/claims/mining/status', { ...auth, onSend: noStore }, async req => {
    parse(z.object({}).strict(), req.query);
    const unavailable: MiningClaimStatus = { wallet: req.wallet, state: 'unavailable',
      reason: phaseEMiningEnabled() ? 'SOURCE_UNAVAILABLE' : 'DISABLED', decimals: TOKEN.decimals,
      preparationAllowed: false, claimSubmissionAuthorized: false };
    return toMiningClaimStatusView(reader ? await reader.status(req.wallet) : unavailable, serverNow(), identity&&phaseEMiningEnabled()?identity:identity?{programId:identity.programId,keepMint:identity.keepMint}:undefined);
  });
  app.post('/claims/mining/prepare', post, async (req, reply) => {
    const input = parse(MiningClaimPrepareRequestSchema, req.body);
    const prior = await getMiningClaimPreparation(db, { wallet: req.wallet, idempotencyKey: input.idempotencyKey });
    if (prior) {if(prior.format?.preset!==input.profile)throw new HttpError(409,'The saved claim uses its original profile','MINING_CLAIM_REQUEST_CONFLICT');return reply.code(201).send(toMiningClaimPreparationView(prior, serverNow()));}
    if (!prepare) throw new HttpError(503, 'Mining claim preparation is unavailable', 'CLAIM_UNAVAILABLE');
    try { return reply.code(201).send(toMiningClaimPreparationView(await prepare.prepare(req.wallet, input), serverNow())); }
    catch (error) { refused(error); }
  });
  app.get('/claims/mining/prepare/by-key/:key', { ...auth, onSend: noStore }, async req => {
    const { key } = parse(z.object({ key: z.uuid() }).strict(), req.params);
    parse(z.object({}).strict(), req.query);
    const preparation = await getMiningClaimPreparation(db, { wallet: req.wallet, idempotencyKey: key });
    return toMiningClaimPreparationEnvelope({ wallet: req.wallet, idempotencyKey: key, preparation, serverNow: serverNow() });
  });
  app.post('/claims/mining/submit', post, async (req, reply) => {
    const input = parse(MiningClaimSubmitRequestSchema, req.body);
    let signed;
    try { signed = await acceptMiningClaimSigned(db, { wallet: req.wallet, claimId: input.claimId,
      signedTransaction: Buffer.from(input.signedTransaction, 'base64') }); }
    catch (error) { refused(error); }
    const request = { wallet: req.wallet, claimId: input.claimId, ordinal: signed.ordinal };
    // Retention is allowed during pause/provider loss. Any outcome from here
    // preserves the original signed evidence; a held reply is not a rejection.
    let result;
    try {
      const failure = await getMiningClaimFailure(db, request), saved = await getMiningClaimSettlement(db, request);
      result = failure ? { status: 'failed' as const } : saved ? { status: 'settled' as const } : relay ? await relay(request) : { status: 'held' as const, reason: 'PROVIDER_UNAVAILABLE' };
    } catch {
      // The signed commit already succeeded. Keep its identity even when the
      // receipt reader is unavailable, so clients retain their recovery journal.
      result = { status: 'held' as const, reason: 'SOURCE_UNAVAILABLE' };
    }
    return reply.code(result.status === 'settled' ? 200 : 202).send({ claimId: input.claimId, signature: signed.signature,
      delivery: result.status === 'failed' ? 'held' : result.status, ...(result.status === 'held' ? { reason: result.reason } : result.status === 'failed' ? { reason: 'CLAIM_FAILED_CHECK_RECEIPT' } : {}), serverNow: serverNow() });
  });
  app.get('/claims/mining/:claimId/review',{...auth,onSend:noStore},async req=>{
    const {claimId}=parse(z.object({claimId:z.uuid()}).strict(),req.params),{ordinal}=parse(z.object({ordinal:z.enum(['0','1']).transform(Number)}).strict(),req.query);
    if(!review)throw new HttpError(503,'Mining claim review is unavailable','MINING_CLAIM_PROVIDER_UNAVAILABLE');
    try{return MiningClaimReviewSchema.parse(await review({wallet:req.wallet,claimId,ordinal}));}catch(error){refused(error);}
  });
  const continuationEnvelope=(wallet:string,parentClaimId:string,saved:Awaited<ReturnType<typeof getMiningClaimContinuation>>)=>MiningClaimContinuationEnvelopeSchema.parse({version:1,wallet,parentClaimId,status:saved?'continued':'unknown',continuation:saved,serverNow:serverNow()});
  app.get('/claims/mining/:claimId/continuation',{...auth,onSend:noStore},async req=>{
    const {claimId}=parse(z.object({claimId:z.uuid()}).strict(),req.params);parse(z.object({}).strict(),req.query);
    try{return continuationEnvelope(req.wallet,claimId,await getMiningClaimContinuation(db,{wallet:req.wallet,claimId},serverNow()));}catch(error){refused(error);}
  });
  app.post('/claims/mining/:claimId/continue',post,async(req,reply)=>{
    const {claimId}=parse(z.object({claimId:z.uuid()}).strict(),req.params);parse(z.object({}).strict(),req.query);const input=parse(MiningClaimContinuationRequestSchema,req.body),k={wallet:req.wallet,claimId};
    try{const saved=await getMiningClaimContinuation(db,k,serverNow());if(saved){if(saved.childPreparation.idempotencyKey!==input.idempotencyKey)throw new MiningClaimContinuationError('REQUEST_CONFLICT');return reply.code(201).send(continuationEnvelope(req.wallet,claimId,saved));}
      if(!continuation)throw new HttpError(503,'Mining continuation is unavailable','MINING_CLAIM_PROVIDER_UNAVAILABLE');
      return reply.code(201).send(continuationEnvelope(req.wallet,claimId,await continuation(k,input)));
    }catch(error){refused(error);}
  });
  app.get('/claims/mining/:claimId', { ...auth, onSend: noStore }, async req => {
    const { claimId } = parse(z.object({ claimId: z.uuid() }).strict(), req.params);
    parse(z.object({}).strict(), req.query);
    const signed = await getMiningClaimSigned(db, { wallet: req.wallet, claimId });
    const settlements = [], failures = [];
    for (const wire of signed?.wires ?? []) {
      const saved = await getMiningClaimSettlement(db, { wallet: req.wallet, claimId, ordinal: wire.ordinal });
      if (saved) settlements.push(saved);
      const failure = await getMiningClaimFailure(db, { wallet: req.wallet, claimId, ordinal: wire.ordinal });
      if (failure) failures.push(failure);
    }
    return toMiningClaimView({ wallet: req.wallet, claimId, signed, settlements, failures, serverNow: serverNow() });
  });
}
