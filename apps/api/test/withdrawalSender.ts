import {
  makeHotWalletKeepSender,
  type KeepTransferSender,
  type KeepWithdrawalFinality,
  type KeepWithdrawalPreparationRequest,
  type PreparedKeepWithdrawal,
} from '@shardkeep/chain';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { currentKeepMint } from '../src/money/mintDimension';

export interface TestKeepSenderOptions {
  prepare?: (
    request: KeepWithdrawalPreparationRequest,
    prepared: PreparedKeepWithdrawal,
  ) => void | Promise<void>;
  broadcast?: (prepared: PreparedKeepWithdrawal) => void | string | Promise<void | string>;
  reconcile?: (prepared: PreparedKeepWithdrawal) => KeepWithdrawalFinality | Promise<KeepWithdrawalFinality>;
}

/** A fully signed, locally validated sender with injectable network outcomes. */
export function makeTestKeepSender(options: TestKeepSenderOptions = {}): KeepTransferSender {
  const mint = currentKeepMint();
  if (!mint) throw new Error('test KEEP mint unavailable');
  const blockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    rpcEndpoint: 'test-primary',
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1_000 }),
  } as unknown as Connection;
  const local = makeHotWalletKeepSender(connection, Keypair.generate(), new PublicKey(mint));
  return {
    async prepare(request) {
      const prepared = await local.prepare(request);
      await options.prepare?.(request, prepared);
      return prepared;
    },
    async broadcast(prepared) {
      const signature = await options.broadcast?.(prepared);
      return signature ?? prepared.signature;
    },
    async reconcile(prepared) {
      return options.reconcile?.(prepared)
        ?? { status: 'finalized_success', source: 'test-primary' };
    },
  };
}

export const FINALITY_PENDING: KeepWithdrawalFinality = {
  status: 'pending', expired: false, observations: ['test-primary:unavailable'],
};
