/** Read-only full verification for a restored/off-host signer journal. */
import { pathToFileURL } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { verifyWithdrawalPolicyState } from './money/policySigner';

export async function runPolicySignerStateVerify(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (argv.length !== 1) throw new Error('usage: policySignerVerify.ts <state-file>');
  const mint = env['WITHDRAWAL_POLICY_KEEP_MINT']?.trim();
  const sourceOwner = env['HOT_WALLET_PUBKEY']?.trim();
  if (!mint || !sourceOwner) throw new Error('policy signer public custody identity is required');
  return verifyWithdrawalPolicyState(argv[0]!, {
    mint: new PublicKey(mint), sourceOwner: new PublicKey(sourceOwner),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`verified ${await runPolicySignerStateVerify()} durable policy signer artifact(s)`);
}
