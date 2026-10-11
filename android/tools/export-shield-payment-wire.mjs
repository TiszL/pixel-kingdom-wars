// Run with the pinned source's tsx loader and PKW_NATIVE_SOURCE; no wallet/RPC calls.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const source = path.resolve(process.env.PKW_NATIVE_SOURCE || '.source');
const sourcePath = 'apps/web/src/lib/chain.ts';
if (execFileSync('git', ['-C', source, 'status', '--porcelain', '--', sourcePath, 'packages/shared/src/constants.ts', 'infra/devnet.addresses.json', 'pnpm-lock.yaml'], { encoding: 'utf8' }).trim()) {
  throw new Error('Shield vectors require committed canonical payment inputs');
}
const input = fs.readFileSync(path.join(source, sourcePath), 'utf8');
const scripts = createRequire(path.join(source, 'scripts/package.json'));
const web = createRequire(path.join(source, 'apps/web/package.json'));
const ts = scripts('typescript');
const web3 = web('@solana/web3.js');
const registry = JSON.parse(fs.readFileSync(path.join(source, 'infra/devnet.addresses.json')));
const constants = await import(pathToFileURL(path.join(source, 'packages/shared/src/constants.ts')).href);
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: module.exports, module, Buffer, TextEncoder,
    require: id => id === './cluster' ? { SOLANA: { addresses: registry } } : web(id) }, { filename: sourcePath });
const wallet = new web3.PublicKey(new Uint8Array(32).fill(1));
const reference = new web3.PublicKey(new Uint8Array(32).fill(2));
const blockhash = new web3.PublicKey(new Uint8Array(32).fill(3)).toBase58();
const amount = BigInt(constants.WARZONE.shieldCostSolLamports);
const direct = amount * BigInt(constants.WARZONE.shieldLiquidityDirectBps) / 10000n;
const split = amount - direct;
const cases = [
  { kind: 'shield', amount: BigInt(constants.SHIELD.extendCostSolLamports), destination: null,
    transaction: module.exports.buildBuySinkTx(wallet, reference, 'shield', BigInt(constants.SHIELD.extendCostSolLamports)) },
  { kind: 'warzone_shield', amount, destination: registry.treasuries.liquidity, direct, split,
    transaction: module.exports.buildWarzoneShieldTx({ wallet, reference, directLamports: direct, splitLamports: split }) },
];
const fixture = {
  sourceCommit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourcePath,
  sourceSha256: createHash('sha256').update(input).digest('hex'),
  provenance: 'Actual canonical web instruction builders executed; prices and split from canonical constants; only the public devnet address module injected.',
  wallet: wallet.toBase58(), reference: reference.toBase58(), blockhash,
  vectors: cases.map(c => {
    c.transaction.feePayer = wallet; c.transaction.recentBlockhash = blockhash;
    return { kind: c.kind, amountLamports: c.amount.toString(), destination: c.destination,
      directLamports: c.direct?.toString() ?? null, splitLamports: c.split?.toString() ?? null,
      unsigned: c.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      instructions: c.transaction.instructions.map(ix => ({ program: ix.programId.toBase58(), data: ix.data.toString('hex'),
        keys: ix.keys.map(k => ({ address: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })) })) };
  }),
};
const output = path.resolve('wallet/src/test/resources/shield-purchase-wire.json');
fs.writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n');
console.log(`Wrote ${fixture.vectors.length} canonical shield payment vectors.`);
