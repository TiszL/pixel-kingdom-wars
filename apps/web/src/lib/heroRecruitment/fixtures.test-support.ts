import { HEROES } from '@shardkeep/shared';
import type { HeroRecruitmentReceipt } from '@shardkeep/shared/heroRecruitment';
import type { BasesDto } from '../api';
import type { BaseStateDto } from '../../state/store';
import { makeHeroRecruitmentIntent, type HeroRecruitmentIdentity } from './journal';
export const identity: HeroRecruitmentIdentity = { api: 'https://game.example/api', wallet: '11111111111111111111111111111111', cluster: 'devnet' };
export const target = '22222222222222222222222222222222';
export const key = '00000000-0000-4000-8000-000000000001';
export const baseA = '00000000-0000-4000-8000-000000000002';
export const baseB = '00000000-0000-4000-8000-000000000003';
export const buildingId = '00000000-0000-4000-8000-000000000004';
export const jobId = '00000000-0000-4000-8000-000000000005';
export const itemUseId = '00000000-0000-4000-8000-000000000006';
export const request = (baseId: string | null = baseA, contractOnly = true, type: 'heroaltar' | 'siegestool' = 'heroaltar', idempotencyKey = key) => ({
  idempotencyKey, baseId, type, tx: 10, ty: 10, heroContractOnly: contractOnly,
  maxCostKeep: contractOnly ? '0' : String(HEROES[type === 'heroaltar' ? 'vex' : 'theodor'].recruitCostKeep),
});
export const intent = (mechanism: 'v1' | 'legacy' = 'v1', baseId: string | null = baseA, contractOnly = true, type: 'heroaltar' | 'siegestool' = 'heroaltar', idempotencyKey = key) => makeHeroRecruitmentIntent(mechanism, request(baseId, contractOnly, type, idempotencyKey));
export const input = { baseId: baseA, type: 'heroaltar' as const, tx: 10, ty: 10 };
export const receipt = (baseId: string | null = baseA, contractOnly = true, type: 'heroaltar' | 'siegestool' = 'heroaltar'): HeroRecruitmentReceipt => ({
  version: 1, actor: identity.wallet, idempotencyKey: key, request: request(baseId, contractOnly, type), hero: type === 'heroaltar' ? 'vex' : 'theodor',
  building: { id: buildingId, baseId, type, tx: 10, ty: 10, level: 1 },
  job: { id: jobId, buildingId, startedAt: '2026-09-13T00:00:00.000Z', finishesAt: '2026-09-13T01:00:00.000Z' },
  funding: contractOnly ? { kind: 'contract', itemId: HEROES[type === 'heroaltar' ? 'vex' : 'theodor'].recruitItemId, itemUseId, sourceBaseId: baseId, quantity: 1 }
    : { kind: 'keep', amount: String(HEROES[type === 'heroaltar' ? 'vex' : 'theodor'].recruitCostKeep), ledgerTransactionId: itemUseId },
  createdAt: '2026-09-13T00:00:00.000Z',
});
export const legacyAck = (baseId: string | null = baseA) => ({ building: { ...receipt(baseId).building, playerWallet: identity.wallet } });
export const status = (r: HeroRecruitmentReceipt | null = null, enabled = true, idempotencyKey = key) => ({ version: 1, wallet: identity.wallet, idempotencyKey, enabled, receipt: r });
export const hydration = { base: 'refreshed', items: 'refreshed', roster: 'refreshed' } as const;
export const directory = (): BasesDto => ({ enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [
  { id: baseA, status: 'active', slot: 1 }, { id: baseB, status: 'active', slot: 2 },
] } as BasesDto);
export const base = (baseId: string | null = baseA): BaseStateDto => ({ baseId, player: { wallet: identity.wallet, name: 'Fixture', keepLevel: 6, builders: 1, expansions: 1, trophies: 0, league: 'none' },
  claim: { min: 0, max: 40 }, buildings: [], obstacles: [], jobs: [], freeBuilders: 1, army: [], energy: { used: 0, free: 1, max: 1 }, shield: null });
export const items = (contracts = 1) => ({ catalog: Object.values(HEROES).map(hero => ({ id: hero.recruitItemId, activation: { kind: 'hero', active: false, availableContracts: contracts } })) });
export const heroes = () => ({ heroes: Object.entries(HEROES).map(([hero, spec]) => ({ hero, name: spec.name, title: 'Fixture Hero', level: 1, recoveryUntil: null, recoveryFinishNow: null, unlockKeepLevel: spec.unlockKeepLevel, altar: spec.altar, recruitItemId: spec.recruitItemId, recruitCostKeep: String(spec.recruitCostKeep), recruited: false, available: true })) });
export const read = async (path: string): Promise<unknown> => {
  if (path.startsWith('/heroes/recruit/v1/')) return status(null, true, path.split('/').at(-1));
  if (path === '/me') return { wallet: identity.wallet, entryPaid: true }; if (path === '/bases') return directory();
  if (path.startsWith('/base?') || path === '/base') return base(new URL(path, identity.api).searchParams.get('baseId'));
  if (path.startsWith('/balances')) return { keep: '1000000', shards: '1000', keepRate: 1, features: { gameCurrency: { version: 1, exactSpendCurrency: 1 } } };
  if (path.startsWith('/items')) return items(); if (path.startsWith('/heroes')) return heroes(); throw new Error(`Unexpected ${path}`);
};
export const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
