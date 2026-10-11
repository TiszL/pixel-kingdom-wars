import type { FastifyInstance } from 'fastify';
import type { ChainAddresses } from '@shardkeep/chain';
import type { Config } from './config';
import type { Db } from './db/client';
import type { FinalizedDeedReader } from './game/baseOwnership';

export interface DevnetOnlyOptions {
  config: Config;
  db: Db;
  addresses: ChainAddresses | null;
  deedReader?: FinalizedDeedReader | null;
  deedCollection?: string | null;
}
interface LoadedDevnetOnly {
  registerDevnetOnly(app: FastifyInstance, options?: DevnetOnlyOptions): void | Promise<void>;
  registerDevnetOnlyJobs(options?: DevnetOnlyOptions): Promise<{ close(): Promise<void> } | null>;
}
export interface DevnetOnlyContext {
  cluster: Config['SOLANA_CLUSTER'];
  enabled?: string | undefined;
  options?: DevnetOnlyOptions;
  importer?: () => Promise<LoadedDevnetOnly>;
}
const importer = () => import('./devnet-only/index');
export async function loadDevnetOnlyRoutes(app: FastifyInstance, ctx: DevnetOnlyContext): Promise<void> {
  if (ctx.cluster !== 'devnet' || ctx.enabled !== 'true') return;
  await (await (ctx.importer ?? importer)()).registerDevnetOnly(app, ctx.options);
}
export async function loadDevnetOnlyJobs(ctx: DevnetOnlyContext): Promise<{ close(): Promise<void> } | null> {
  if (ctx.cluster !== 'devnet' || ctx.enabled !== 'true') return null;
  return (await (ctx.importer ?? importer)()).registerDevnetOnlyJobs(ctx.options);
}
export function assertDevnetOnlyAbsentOnMainnet(
  cluster: Config['SOLANA_CLUSTER'], exists: (path: URL) => boolean,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (cluster !== 'mainnet-beta') return;
  if (Object.keys(env).some((key) => key.startsWith('DEVNET_SKR_FAUCET_'))
      || exists(new URL('./devnet-only', import.meta.url))) {
    throw new Error('mainnet refuses devnet-only faucet code or configuration');
  }
}
