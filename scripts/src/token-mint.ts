/**
 * CLI: create the branded Pixel Kingdom Gold (KEEP) mint on devnet (Phase 6).
 * Creates the mint + attaches Metaplex metadata (via createBrandedMint), then
 * persists the mint keypair so you can mint supply with spl-token. One-time.
 *
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   ADMIN_KEYPAIR_PATH=~/.config/solana/id.json \
 *   pnpm --filter @shardkeep/scripts token:mint -- --uri https://<host>/keep-metadata.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBrandedMint } from '@shardkeep/chain';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
  const adminPath = process.env['ADMIN_KEYPAIR_PATH'] ?? join(homedir(), '.config', 'solana', 'id.json');
  const metadataUri = arg('uri');
  if (!metadataUri) throw new Error('pass --uri <metadata-json-url>');

  const adminSecret = Uint8Array.from(JSON.parse(readFileSync(adminPath, 'utf8')) as number[]);
  console.log(`[token] cluster ${rpcUrl}`);
  console.log(`[token] metadata ${metadataUri}`);

  const res = await createBrandedMint({ rpcUrl, adminSecret, metadataUri });

  // Persist the mint keypair so ops keeps mint authority (re-fund the hot wallet later).
  // Name the file after the mint it belongs to and NEVER overwrite: the old
  // hard-coded `keep-mint-v2.keypair.json` meant each rotation wrote the new
  // secret over the previous one (that is how the v2 file was lost on
  // 2026-07-28 — harmless there, since mint/freeze/update authority live on
  // the admin keypair, but a key-destruction incident on mainnet).
  const keyPath = resolve(
    import.meta.dirname, '..', '..', 'infra', 'keys', `keep-mint-${res.mint}.keypair.json`,
  );
  if (existsSync(keyPath)) throw new Error(`refusing to overwrite ${keyPath}`);
  writeFileSync(keyPath, JSON.stringify(Array.from(res.mintSecretKey)));

  console.log('\n✅ Branded KEEP mint created + metadata attached');
  console.log(`   mint:    ${res.mint}`);
  console.log(`   keypair: ${keyPath}`);
  console.log('\nNEXT — mint the custodial supply to the hot wallet (spl-token CLI):');
  console.log(`   spl-token create-account ${res.mint} --owner <HOT_WALLET> --fee-payer <ADMIN> --url devnet`);
  console.log(`   spl-token mint ${res.mint} 500000000 --recipient-owner <HOT_WALLET> --mint-authority ${adminPath} --url devnet`);
  console.log(`   spl-token display ${res.mint} --url devnet   # verify name/symbol/logo`);
}

main().catch((e) => { console.error(e); process.exit(1); });
