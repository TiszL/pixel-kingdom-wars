/** Rehearse K208's known Core bypass against an actually craft-created Charter. */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { withCharterValidator } from './charter-local-fixture';

type Fixture = Parameters<Parameters<typeof withCharterValidator>[2]>[0];
const requireChain = createRequire(join(dirname(resolve(process.argv[1]!)), '../packages/chain/package.json'));
const core: typeof import('../packages/chain/node_modules/@metaplex-foundation/mpl-core') = requireChain('@metaplex-foundation/mpl-core');
const umiApi: typeof import('../packages/chain/node_modules/@metaplex-foundation/umi') = requireChain('@metaplex-foundation/umi');
const umiBundle: typeof import('../packages/chain/node_modules/@metaplex-foundation/umi-bundle-defaults') = requireChain('@metaplex-foundation/umi-bundle-defaults');
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }

export async function verifyCharterAuthority(fixture: Fixture, asset: PublicKey, collection: PublicKey, owner: Keypair): Promise<string[]> {
  const { connection, payer, execute, snapshots } = fixture;
  const outsider = Keypair.generate();
  const umi = umiBundle.createUmi(connection.rpcEndpoint).use(core.mplCore());
  const signer = (key: Keypair) => umiApi.createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(key.secretKey));
  const admin = signer(payer), upk = (key: PublicKey) => umiApi.publicKey(key.toBase58());
  umi.use(umiApi.keypairIdentity(admin));
  const before = JSON.stringify(await snapshots([asset, collection]));
  const outcomes: string[] = [];
  for (const [actorName, actor] of [['bootstrap admin', payer], ['owner', owner], ['outsider', outsider]] as const) {
    const accounts = { asset: upk(asset), collection: upk(collection), payer: admin, authority: signer(actor) };
    const attempts = [
      ['revoke PFD', core.revokePluginAuthorityV1(umi, { ...accounts, pluginType: core.PluginType.PermanentFreezeDelegate }), 26],
      ['thaw', core.updatePluginV1(umi, { ...accounts, plugin: core.plugin('PermanentFreezeDelegate', [{ frozen: false }]) }), 26],
      ...(actorName === 'owner' ? [['transfer frozen asset', core.transferV1(umi, { ...accounts, newOwner: upk(outsider.publicKey) }), 9] as const] : []),
    ] as const;
    for (const [operation, builder, code] of attempts) {
      const label = actorName + ' cannot ' + operation;
      const instructions = builder.getInstructions();
      check(instructions.length === 1 && instructions[0]!.programId.toString() === CORE.toBase58(), 'Expected one direct Core authority attempt');
      const instruction = instructions[0]!;
      await execute(label, new TransactionInstruction({ programId: CORE, data: Buffer.from(instruction.data),
        keys: instruction.keys.map(key => ({ pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable })) }),
      [actor], { program: CORE, code });
      check(JSON.stringify(await snapshots([asset, collection])) === before, label + ': changed the actual previously verified frozen profile');
      outcomes.push(label);
    }
  }
  check(outcomes.length === 7, 'Incomplete known-bypass refusal matrix');
  // Exact runtime owner, lamports, executable flag and every data byte remain
  // identical to the actual profile accepted by the strict decoder before us.
  return outcomes;
}
