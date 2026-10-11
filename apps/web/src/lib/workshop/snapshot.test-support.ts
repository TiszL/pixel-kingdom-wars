import type { BaseStateDto } from '../../state/store';
import { identity, id, view } from './fixtures.test-support';
export const base = (): BaseStateDto => ({ baseId: id(1), player: { wallet: identity.wallet, name: 'Keeper', keepLevel: 1, trophies: 0, league: 'bronze', builders: 1, expansions: 0 },
  claim: { min: 0, max: 30 }, energy: { used: 0, free: 6, max: 6 }, shield: null, buildings: [{ id: id(8), type: 'workshop', level: 1, tx: 1, ty: 1, underConstruction: false }], obstacles: [], army: [], jobs: [], freeBuilders: 1 });
export const funds = { keep: '500', shards: '70000', gems: '12', keepRate: 1 };
export const directory = () => ({ enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: id(1), status: 'active', slot: 1 }] });
export const capabilities = (enabled = true) => ({ protocolVersion: 1, economy: { workshop: { enabled, recipeVersion: 1 } } });
export const snapshotRead = async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet };
  if (path === '/bases') return directory();
  if (path.startsWith('/base?')) return base();
  if (path.startsWith('/balances?')) return funds;
  if (path.startsWith('/workshop?')) return view();
  if (path === '/native/capabilities') return capabilities();
  throw new Error(`Unexpected ${path}`);
};
