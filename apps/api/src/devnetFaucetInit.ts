/** DEVNET PLAYTEST ONLY — create the in-game faucet treasury keypair once.
 *  Usage: pnpm --filter @shardkeep/api devnet-faucet:init [path]
 *  Writes a 0600 keypair file if none exists and prints the public address to
 *  fund with devnet SOL. Never prints the secret. Remove before mainnet. */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';

const target = resolve(process.argv[2] ?? process.env['DEVNET_FAUCET_KEYPAIR_PATH'] ?? 'infra/keys/devnet-faucet.keypair.json');
if (existsSync(target) && !statSync(target).isFile()) {
  console.error(`${target} exists but is not a regular file (a compose bind mount creates a directory when the key is missing) — remove it and re-run`);
  process.exit(1);
}
if (existsSync(target)) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(target, 'utf8')) as number[]);
  console.log(`devnet faucet keypair already exists at ${target}`);
  console.log(`address: ${Keypair.fromSecretKey(secret).publicKey.toBase58()}`);
} else {
  const keypair = Keypair.generate();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  chmodSync(target, 0o600);
  console.log(`devnet faucet keypair written to ${target} (mode 0600)`);
  console.log(`address: ${keypair.publicKey.toBase58()}`);
  console.log('fund it with devnet SOL (e.g. solana transfer <address> <amount> --url devnet, or faucet.solana.com).');
}
