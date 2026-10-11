/** Command-local consent, negotiated independently of the Gems feature switch. */
export type GameCurrency = 'GEMS' | 'KEEP';
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)
    || BigInt(value) > 9223372036854775807n) throw new Error('Game currency balances did not refresh.');
  return BigInt(value);
}
export function exactGameCurrencyAvailable(raw: unknown): boolean {
  const feature = record(record(record(raw)?.features)?.gameCurrency);
  return feature?.version === 1 && feature.exactSpendCurrency === 1;
}
export function gemsGameCurrencyAvailable(raw: unknown): boolean {
  const feature = record(record(record(raw)?.features)?.gems);
  return feature?.version === 1 && feature.receipts === 1;
}
export function chooseGameCurrency(price: string, raw: unknown): GameCurrency {
  if (!exactGameCurrencyAvailable(raw)) throw new Error('This server cannot enforce a reviewed currency. Update before making a paid game action.');
  const cost = amount(price), balances = record(raw);
  if (cost <= 0n) throw new Error('A paid game command needs a positive price.');
  if (gemsGameCurrencyAvailable(raw) && amount(balances?.gems) >= cost) return 'GEMS';
  if (amount(balances?.keep) >= cost) return 'KEEP';
  throw new Error('Neither Gems nor custodial KEEP covers the whole price. Get Gems before reviewing again.');
}
/** Rechecking cannot silently choose another currency after the player reviewed. */
export function assertGameCurrency(currency: GameCurrency, price: string, raw: unknown): void {
  if (!exactGameCurrencyAvailable(raw)) throw new Error('Currency enforcement is unavailable. Keep the original command and refresh.');
  if (currency === 'GEMS' && !gemsGameCurrencyAvailable(raw)) throw new Error('Gems are paused. Keep the original command and refresh.');
  const cost = amount(price);
  if (cost <= 0n || amount(record(raw)?.[currency === 'GEMS' ? 'gems' : 'keep']) < cost) {
    throw new Error(`The reviewed ${currency} no longer covers this price. Refresh before reviewing again.`);
  }
}
