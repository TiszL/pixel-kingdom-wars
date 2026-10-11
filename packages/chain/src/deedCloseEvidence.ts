/** D-118 read-only chain proof between a finalized observer anchor and campaign close.
 * A fresh current owner cannot establish who held a transferable deed at close.
 */
import { PublicKey, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import { getTransferV1InstructionDataSerializer, getUpdateV1InstructionDataSerializer, getUpdateV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import bs58 from 'bs58';
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

export interface DeedOwnerTransition { instructionIndex: number; from: string; to: string }
export function replayDeedOwner(tx: VersionedTransactionResponse, asset: string, collection: string, owner: string, transitions?: DeedOwnerTransition[]): string {
  if (!tx.meta) throw new Error('transaction execution metadata unavailable');
  if (tx.meta.err) return owner;
  if (!Array.isArray(tx.meta.innerInstructions)) throw new Error('inner execution trace unavailable');
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? null });
  // A failed CPI can be caught by a successful outer transaction. Without a
  // complete execution trace, do not treat that attempted mutation as committed.
  for (const group of tx.meta.innerInstructions ?? []) for (const ix of group.instructions) {
    if (keys.get(ix.programIdIndex)?.equals(CORE) && keys.get(ix.accounts[0]!)?.toBase58() === asset) {
      const opcode = bs58.decode(ix.data)[0];
      if (![2, 4, 6, 8, 10, 22, 24, 26, 28].includes(opcode!)) throw new Error('Core CPI ownership evidence requires reconciliation');
    }
  }
  const committed: DeedOwnerTransition[] = [];
  for (const [instructionIndex, ix] of tx.transaction.message.compiledInstructions.entries()) {
    if (!keys.get(ix.programIdIndex)?.equals(CORE) || keys.get(ix.accountKeyIndexes[0]!)?.toBase58() !== asset) continue;
    const opcode = ix.data[0];
    if (opcode === 14) {
      getTransferV1InstructionDataSerializer().deserialize(ix.data);
      if (keys.get(ix.accountKeyIndexes[1]!)?.toBase58() !== collection) throw new Error('transfer collection mismatch');
      const next = keys.get(ix.accountKeyIndexes[4]!);
      if (!next || next.equals(CORE)) throw new Error('transfer recipient unavailable');
      committed.push({ instructionIndex, from: owner, to: next.toBase58() });
      owner = next.toBase58();
    } else if (opcode === 15 || opcode === 30) {
      const decoder = opcode === 15 ? getUpdateV1InstructionDataSerializer() : getUpdateV2InstructionDataSerializer();
      const [data] = decoder.deserialize(ix.data);
      if ((opcode === 30 && keys.get(ix.accountKeyIndexes[4]!)?.toBase58() !== CORE.toBase58()) || data.newUpdateAuthority.__option !== 'None') throw new Error('collection mutation requires reconciliation');
    } else if (![2, 4, 6, 8, 10, 22, 24, 26, 28, 31].includes(opcode!)) {
      throw new Error('unsupported Core mutation requires reconciliation');
    }
  }
  // Publish transitions only after the complete successful replay. A later
  // unsupported instruction must not leak a partially accepted history.
  transitions?.push(...committed);
  return owner;
}

export async function readDeedOwnerAtClose(connection: Connection, input: {
  assetId: string; collection: string; owner: string; priorSlot: string; endAt: Date;
}) {
  const priorSlot = Number(input.priorSlot);
  if (!Number.isSafeInteger(priorSlot) || priorSlot < 0) throw new Error('invalid prior finalized slot');
  const through = await connection.getSlot('finalized');
  const [throughTime, priorTime] = await Promise.all([connection.getBlockTime(through), connection.getBlockTime(priorSlot)]);
  if (throughTime === null || throughTime * 1000 < input.endAt.getTime() || priorTime === null || priorTime * 1000 >= input.endAt.getTime()) {
    throw new Error('finalized observations do not bracket campaign close');
  }
  const rows: Array<{ signature: string; slot: number }> = [];
  const seen = new Set<string>();
  let before: string | undefined, reachedAnchor = false;
  for (let page = 0; page < 200; page++) {
    const history = await connection.getSignaturesForAddress(new PublicKey(input.assetId), { limit: 1000, ...(before ? { before } : {}) }, 'finalized');
    for (const row of history) {
      if (seen.has(row.signature)) throw new Error('overlapping transaction history pages');
      seen.add(row.signature);
      if (row.slot <= priorSlot) reachedAnchor = true;
      else if (row.slot <= through && !row.err) rows.push(row);
    }
    if (reachedAnchor || history.length < 1000) break;
    before = history.at(-1)!.signature;
  }
  if (!reachedAnchor) throw new Error('transaction history does not reach observer anchor');
  const transactions = [];
  const blockOrders = new Map<number, string[]>();
  for (const row of rows) {
    const tx = await connection.getTransaction(row.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!tx?.meta || tx.slot !== row.slot || tx.blockTime == null) throw new Error('transaction evidence unavailable');
    if (tx.blockTime * 1000 >= input.endAt.getTime()) continue; // exclusive end
    let order = blockOrders.get(row.slot);
    if (!order) { order = (await connection.getBlockSignatures(row.slot, 'finalized')).signatures; blockOrders.set(row.slot, order); }
    const index = order.indexOf(row.signature);
    if (index < 0) throw new Error('transaction order unavailable');
    transactions.push({ tx, index, signature: row.signature });
  }
  transactions.sort((a, b) => a.tx.slot - b.tx.slot || a.index - b.index);
  let owner = input.owner;
  for (const row of transactions) owner = replayDeedOwner(row.tx, input.assetId, input.collection, owner);
  return { ownerAtClose: owner, throughSlot: String(through), evidence: {
    priorSlot: input.priorSlot, priorOwner: input.owner, endAt: input.endAt.toISOString(), throughBlockTime: throughTime,
    signatures: transactions.map(t => ({ signature: t.signature, slot: t.tx.slot, transactionIndex: t.index })),
  } };
}
