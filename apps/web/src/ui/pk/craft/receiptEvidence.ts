/** Internal F2b receipt-presence rule. The host supplies the authoritative receipt for the current operation. */
export function hasReceipt(receiptId: unknown): receiptId is string {
  return typeof receiptId === 'string' && receiptId.trim().length > 0;
}
