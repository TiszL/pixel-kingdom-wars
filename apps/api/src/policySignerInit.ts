/** One-time operator ceremony for an empty withdrawal policy state file. */
import { pathToFileURL } from 'node:url';
import { initializeWithdrawalPolicyState } from './money/policySigner';

export async function runPolicySignerStateInit(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (argv.length !== 1 || argv[0] !== '--confirm-empty-state') {
    throw new Error('refusing to initialize signer state without --confirm-empty-state');
  }
  const stateFile = env['WITHDRAWAL_POLICY_SIGNER_STATE_FILE']?.trim();
  if (!stateFile) throw new Error('WITHDRAWAL_POLICY_SIGNER_STATE_FILE is required');
  await initializeWithdrawalPolicyState(stateFile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPolicySignerStateInit();
  console.log('empty withdrawal policy signer state initialized');
}
