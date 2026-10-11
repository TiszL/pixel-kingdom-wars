/** Test-only JSON-RPC transport over the accepted serialized claim bank. No validator or live account. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PublicKey, VersionedMessage } from '@solana/web3.js';
import { createDb } from '../../src/db/client';
import type { MiningClaimPreparationFixture } from './miningClaimPreparation';

export async function miningClaimRuntimeRpc(f?: MiningClaimPreparationFixture) {
  const requests: { method: string; params: unknown[] }[] = [], sent: string[] = [];
  let genesis = f?.identity.genesisHash ?? '', stalled = false, arrived: (() => void) | undefined;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { id: string; method: string; params?: unknown[] };
    const params = body.params ?? []; requests.push({ method: body.method, params }); arrived?.();
    if (stalled) return;
    try {
      let result: unknown;
      switch (body.method) {
        case 'getGenesisHash': result = genesis; break;
        case 'getSlot': result = 3003; break;
        case 'getBlockHeight': result = 200; break;
        case 'getLatestBlockhash': result = { context: { slot: 3003 }, value: { blockhash: f!.preparedClaim.blockhash, lastValidBlockHeight: 250 } }; break;
        case 'getFeeForMessage':
          VersionedMessage.deserialize(Buffer.from(params[0] as string, 'base64'));
          result = { context: { slot: 3003 }, value: 5000 }; break;
        case 'getMinimumBalanceForRentExemption': result = Number(params[0]) * 10; break;
        case 'getMultipleAccounts': {
          const rows = new Map(f!.bank.rows.filter(row => row !== null).map(row => [row.address.toBase58(), row]));
          result = { context: { slot: 3003 }, value: (params[0] as string[]).map(address => {
            const row = rows.get(address);
            return row ? { owner: row.owner.toBase58(), executable: row.executable, data: [Buffer.from(row.data).toString('base64'), 'base64'],
              lamports: Number(row.lamports ?? 1), rentEpoch: 0 } : null;
          }) }; break;
        }
        case 'getSignatureStatuses': result = { context: { slot: 3003 }, value: [null] }; break;
        case 'getTransaction': result = null; break;
        case 'sendTransaction':
          sent.push(params[0] as string);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'Test transport lost delivery acknowledgement' } })); return;
        default: throw Error(`Unexpected fixture RPC ${body.method}`);
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) {
      response.statusCode = 500; response.end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No local RPC port');
  return { url: `http://127.0.0.1:${address.port}`, requests, sent, arrival,
    setGenesis: (value: string) => { genesis = value; }, stall: () => { stalled = true; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

export async function miningClaimRestrictedRuntime(f: MiningClaimPreparationFixture) {
  const role = `claim_process_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
  await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role};
    grant select on players,sessions,mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations,mining_claim_signed_wires,mining_claim_receipts,mining_claim_failures to ${role};
    grant insert on mining_claim_preparations,mining_claim_signed_wires to ${role}`);
  const url = new URL(f.url); url.username = role; url.password = password;
  const conn = createDb(url.toString(), { max: 4 });
  return { ...conn, url: url.toString(), async close() { await conn.sql.end(); await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`); } };
}
export const claimRuntimeKey = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
