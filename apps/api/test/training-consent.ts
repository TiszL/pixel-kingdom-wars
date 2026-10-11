/** Existing gameplay regressions now act as an updated client: preview before
 * purchase. Raw functions remain in sequential-training.test.ts for negative
 * consent/race tests. Failed previews do not bypass production validation. */
import {
  getArmyState, quoteTraining, trainBatch as buyBatch, trainTroop as buyUnit, trainSpeedup as finish,
} from '../src/game/army';

export async function trainTroop(...args: Parameters<typeof buyUnit>): ReturnType<typeof buyUnit> {
  if (!args[6] || args[7] === undefined) {
    try {
      const quote = await quoteTraining(args[0], args[1], [{ troop: args[2], count: 1 }], args[4], args[5]);
      args[6] ??= quote.consent; args[7] ??= quote.costShards;
    }
    catch { /* The original mutation still reports its prerequisite refusal. */ }
  }
  return buyUnit(...args);
}
export async function trainBatch(...args: Parameters<typeof buyBatch>): ReturnType<typeof buyBatch> {
  if (!args[7]) {
    try { args[7] = (await quoteTraining(args[0], args[1], args[2], args[5], args[6])).consent; }
    catch { /* Invalid composition/authority remains rejected by the mutation. */ }
  }
  return buyBatch(...args);
}
export async function trainSpeedup(...args: Parameters<typeof finish>): ReturnType<typeof finish> {
  if (!args[5]) {
    try { args[5] = (await getArmyState(args[0], args[1], args[3], args[4]?.baseId)).finishAllQuote; }
    catch { /* Preserve the mutation's own authority/error contract. */ }
  }
  return finish(...args);
}
