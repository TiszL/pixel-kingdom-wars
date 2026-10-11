/** Loopback JSON-RPC serialization of the accepted Seeker term/quote fixture. */
import { createServer } from 'node:http';
import { PublicKey, VersionedMessage, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import type { realmSaleQuoteFixture } from '../../../../packages/chain/src/seekerRealmSaleQuote.fixture';
export type RealmSaleRuntimeFixture = Awaited<ReturnType<typeof realmSaleQuoteFixture>>;
function transaction(value: VersionedTransactionResponse) {
  const m = value.transaction.message;
  return { ...value, transaction: { signatures: value.transaction.signatures, message: {
    header: m.header, accountKeys: m.staticAccountKeys.map(key => key.toBase58()), recentBlockhash: m.recentBlockhash,
    instructions: m.compiledInstructions.map(ix => ({ programIdIndex: ix.programIdIndex, accounts: ix.accountKeyIndexes, data: bs58.encode(ix.data) })),
  } } };
}
export async function realmSaleRuntimeRpc(f: RealmSaleRuntimeFixture) {
  const requests: { method: string; params: unknown[] }[] = [], sent: string[] = [];
  let stalled = false, arrive: (() => void) | undefined; const arrival = new Promise<void>(resolve => { arrive = resolve; });
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw) as { id: string; method: string; params?: unknown[] }, p = input.params ?? [];
    requests.push({ method: input.method, params: p }); arrive?.(); if (stalled) return;
    try {
      let result: unknown;
      switch (input.method) {
        case 'getGenesisHash': result = await f.rpc.getGenesisHash(); break;
        case 'getSlot': result = await f.rpc.getSlot('finalized'); break;
        case 'getBlockHeight': result = f.controls.blockHeight; break;
        case 'getLatestBlockhash': result = await f.rpc.getLatestBlockhashAndContext('finalized'); break;
        case 'getMinimumBalanceForRentExemption': result = await f.rpc.getMinimumBalanceForRentExemption(Number(p[0]), 'finalized'); break;
        case 'getFeeForMessage': result = await f.rpc.getFeeForMessage(VersionedMessage.deserialize(Buffer.from(p[0] as string, 'base64')), 'finalized'); break;
        case 'getMultipleAccounts': {
          const bank = await f.rpc.getMultipleAccountsInfoAndContext((p[0] as string[]).map(key => new PublicKey(key)), p[1] as never);
          result = { context: bank.context, value: bank.value.map(row => row && { owner: row.owner.toBase58(), executable: row.executable,
            lamports: row.lamports, rentEpoch: row.rentEpoch, data: [row.data.toString('base64'), 'base64'] }) }; break;
        }
        case 'getSignaturesForAddress': result = await f.rpc.getSignaturesForAddress(new PublicKey(p[0] as string), p[1] as never, 'finalized'); break;
        case 'getTransaction': { const value = f.bodies.get(p[0] as string); result = value ? transaction(value) : null; break; }
        case 'getBlock': result = { parentSlot: Number(p[0]) - 1, blockTime: null, blockhash: new PublicKey(Buffer.alloc(32, 13)).toBase58(),
          previousBlockhash: new PublicKey(Buffer.alloc(32, 14)).toBase58(), blockHeight: null,
          transactions: [...f.bodies.values()].filter(tx => tx.slot === Number(p[0])).map(transaction) }; break;
        case 'getSignatureStatuses': result = { context: { slot: f.controls.slot }, value: [null] }; break;
        case 'sendTransaction':
          sent.push(p[0] as string); response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32000, message: 'Fixture acknowledgement lost' } })); return;
        default: throw Error(`Unexpected RPC ${input.method}`);
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback RPC port');
  return { requests, sent, arrival, url: `http://127.0.0.1:${address.port}`, stall: () => { stalled = true; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
