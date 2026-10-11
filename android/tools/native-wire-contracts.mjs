import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';

const presentationSchemaNames = ['NativeClock', 'NativeCommand', 'NativePresentation', 'NativePresentationState', 'NativePresentationPage', 'NativeCapabilities'];
const recoverySchemaNames = ['TrainingReceiptQuery', 'TrainingCloseBody', 'TrainingRecovery'];
const constructionSchemaNames = ['ConstructionReceipt'];
const cancellationSchemaNames = ['TrainingCancellationPath','TrainingCancellationBody','TrainingCancellationResult','TrainingCancellationReceiptQuery','TrainingCancellationReceipt'];
// Training schedule v2 (D-114) and research consents: the server refuses a
// mutation without the snapshot it quoted, so the client must carry these exactly.
const scheduleSchemaNames = ['TrainingScheduleConsent', 'TrainingFinishAllConsent'];
const researchSchemaNames = ['ResearchStartConsent', 'ResearchEpisodeConsent', 'ResearchFinishConsent'];
const heroConsentSchemaNames = ['HeroUpgradeConsent', 'HeroRecoveryConsent'];
const heroReceiptSchemaNames = ['HeroUpgradeReceiptQuery', 'HeroRecoveryReceiptQuery', 'HeroUpgradeReceipt', 'HeroRecoveryReceipt'];
export const nativeSchemaNames = [...presentationSchemaNames, ...recoverySchemaNames, ...constructionSchemaNames, ...cancellationSchemaNames, ...scheduleSchemaNames, ...researchSchemaNames, ...heroConsentSchemaNames, ...heroReceiptSchemaNames];
const receiptExtensions = [
  { name: 'WithdrawalReceipt', source: 'apps/api/src/money/withdrawalReceipt.ts', feature: 'WITHDRAWAL_RECEIPT_FEATURE', path: '/withdrawals/receipt' },
  { name: 'ConversionReceipt', source: 'apps/api/src/game/conversionReceipt.ts', feature: 'CONVERSION_RECEIPT_FEATURE', path: '/forge/convert/receipt' },
  { name: 'ForgeContributionReceipt', source: 'apps/api/src/game/forgeContributionReceipt.ts', feature: 'FORGE_CONTRIBUTION_RECEIPT_FEATURE', path: '/forge/contribute/receipt' },
];
export const nativeEndpoints = [
  { method: 'GET', path: '/native/capabilities', response: 'NativeCapabilities' },
  { method: 'GET', path: '/raids/:raidId/presentation', protocolVersion: 1, response: 'NativePresentation' },
  { method: 'GET', path: '/raids/:raidId/presentation', protocolVersion: 2, response: 'NativePresentationPage' },
  { method: 'GET', path: '/army/training/receipt', query: 'TrainingReceiptQuery', response: 'TrainingRecovery' },
  { method: 'POST', path: '/army/training/close', body: 'TrainingCloseBody', response: 'TrainingRecovery' },
  { method: 'GET', path: '/base/buildings/receipt', response: 'ConstructionReceipt' },
  { method: 'POST', path: '/army/train/:queueId/cancel', params: 'TrainingCancellationPath', body: 'TrainingCancellationBody', response: 'TrainingCancellationResult' },
  { method: 'GET', path: '/army/train/:queueId/cancel/receipt', params: 'TrainingCancellationPath', query: 'TrainingCancellationReceiptQuery', response: 'TrainingCancellationReceipt' },
  { method: 'GET', path: '/heroes/:hero/upgrade/receipt', query: 'HeroUpgradeReceiptQuery', response: 'HeroUpgradeReceipt' },
  { method: 'GET', path: '/heroes/:hero/recovery/speedup/receipt', query: 'HeroRecoveryReceiptQuery', response: 'HeroRecoveryReceipt' },
  ...receiptExtensions.map(({ name, path }) => ({ method: 'GET', path, query: `${name}Query`, response: name })),
];

/** Older canonical checkouts predate these additive recovery routes. Never put an
 * endpoint in their pack without its schemas, or hide a partial modern export. */
export function nativeContractMetadata(schemas) {
  const extensions = receiptExtensions.filter(({ name }) => {
    const present = [name, `${name}Query`].map((key) => Object.hasOwn(schemas, key));
    if (present.some(Boolean) && !present.every(Boolean)) throw new Error(`Incomplete canonical native receipt: ${name}`);
    return present.every(Boolean);
  });
  const optionalNames = new Set(receiptExtensions.map(({ name }) => name));
  return {
    endpoints: nativeEndpoints.filter(({ response }) => !optionalNames.has(response) || Object.hasOwn(schemas, response)),
    zod: ['apps/api/src/game/trainingRecovery.ts', 'apps/api/src/game/constructionReceipt.ts', 'apps/api/src/game/trainingCancellationReceipt.ts',
      'apps/api/src/game/trainingSchedule.ts', 'apps/api/src/game/researchConsent.ts',
      'apps/api/src/game/heroConsent.ts', 'apps/api/src/game/heroReceipt.ts', ...extensions.map(({ source }) => source)],
  };
}

/** Requires the source workspace's TS loader, as does the main pack exporter.
 * Source Zod owns validation and all caps; this only bundles its JSON schemas. */
export async function nativeWireContracts(source) {
  const require = createRequire(path.join(source, 'apps/api/package.json'));
  const { z } = await import(pathToFileURL(require.resolve('zod')).href);
  const canonical = await import(pathToFileURL(path.join(source, 'apps/api/src/native/contracts.ts')).href);
  const recovery = await import(pathToFileURL(path.join(source, 'apps/api/src/game/trainingRecovery.ts')).href);
  const construction = await import(pathToFileURL(path.join(source, 'apps/api/src/game/constructionReceipt.ts')).href);
  const cancellation = await import(pathToFileURL(path.join(source, 'apps/api/src/game/trainingCancellationReceipt.ts')).href);
  const schedule = await import(pathToFileURL(path.join(source, 'apps/api/src/game/trainingSchedule.ts')).href);
  const research = await import(pathToFileURL(path.join(source, 'apps/api/src/game/researchConsent.ts')).href);
  const heroConsent = await import(pathToFileURL(path.join(source, 'apps/api/src/game/heroConsent.ts')).href);
  const heroReceipt = await import(pathToFileURL(path.join(source, 'apps/api/src/game/heroReceipt.ts')).href);
  const routes = await readFile(path.join(source, 'apps/api/src/game/routes.ts'), 'utf8');
  const extensions = [];
  for (const extension of receiptExtensions) {
    const filename = path.join(source, extension.source);
    const exists = await stat(filename).then((value) => value.isFile(), (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    const featurePresent = routes.includes(extension.feature);
    const routePresent = routes.includes(extension.path);
    if (!exists && !featurePresent && !routePresent) continue;
    if (!exists || !featurePresent || !routePresent) throw new Error(`Incomplete canonical native receipt support: ${extension.name}`);
    const module = await import(pathToFileURL(filename).href);
    if (module[extension.feature]?.version !== 1) throw new Error(`Unsupported canonical native receipt feature: ${extension.name}`);
    const query = module[`${extension.name}QuerySchema`];
    const receipt = module[`${extension.name}Schema`];
    if (!(query instanceof z.ZodObject) || !(receipt instanceof z.ZodDiscriminatedUnion)
      || receipt.def.discriminator !== 'status') throw new Error(`Malformed canonical native receipt schemas: ${extension.name}`);
    extensions.push({ ...extension, module });
  }
  const registry = z.registry();
  for (const [names, module] of [[presentationSchemaNames, canonical], [recoverySchemaNames, recovery], [constructionSchemaNames, construction],
    [cancellationSchemaNames, cancellation], [scheduleSchemaNames, schedule], [researchSchemaNames, research],
    [heroConsentSchemaNames, heroConsent], [heroReceiptSchemaNames, heroReceipt],
    ...extensions.map(({ name, module }) => [[`${name}Query`, name], module])]) {
    for (const name of names) {
      if (!module[`${name}Schema`]) throw new Error(`Canonical native schema is missing: ${name}`);
      registry.add(module[`${name}Schema`], { id: name });
    }
  }
  // Register the actual union options and nested object schemas so generated
  // Kotlin can decode each status without maintaining a second schema by hand.
  const title = (value) => value[0].toUpperCase() + value.slice(1);
  const registerObjects = (schema, name) => {
    if (schema instanceof z.ZodArray) return registerObjects(schema.element, `${name}Item`);
    if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) return registerObjects(schema.unwrap(), name);
    if (!(schema instanceof z.ZodObject)) return;
    if (!registry.has(schema)) registry.add(schema, { id: name });
    for (const [key, value] of Object.entries(schema.shape)) registerObjects(value, `${name}${title(key)}`);
  };
  for (const [name, union] of [['TrainingRecovery', recovery.TrainingRecoverySchema], ['ConstructionReceipt', construction.ConstructionReceiptSchema], ['TrainingCancellationReceipt',cancellation.TrainingCancellationReceiptSchema],
    ['HeroUpgradeReceipt', heroReceipt.HeroUpgradeReceiptSchema], ['HeroRecoveryReceipt', heroReceipt.HeroRecoveryReceiptSchema],
    ...extensions.map(({ name, module }) => [name, module[`${name}Schema`]])]) {
    for (const option of union.options) {
      const status = option.shape.status.value;
      if (typeof status !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(status)) throw new Error('Unsupported canonical recovery discriminant');
      registerObjects(option, `${name}${title(status)}`);
    }
  }
  // Both consents share one queue row schema instance; name it after the shared type.
  const queueRow = schedule.TrainingScheduleConsentSchema.shape.queue.element;
  if (queueRow !== schedule.TrainingFinishAllConsentSchema.shape.queue.element) throw new Error('Canonical consent queue rows diverged');
  registry.add(queueRow, { id: 'TrainingQueueConsentRow' });
  for (const [name, module] of [...scheduleSchemaNames.map((name) => [name, schedule]), ...researchSchemaNames.map((name) => [name, research])]) {
    registerObjects(module[`${name}Schema`], name);
  }
  // Input mode preserves UUID input bounds before source normalization. JSON
  // Schema cannot express custom Zod refinements (withdrawal gross - fee = net);
  // these schemas/DTOs describe wire shape, never replace server receipt proof.
  const exported = z.toJSONSchema(registry, { io: 'input', uri: (id) => `urn:pkw:native:${id}` }).schemas;
  // Zod emits separate resource identifiers, including recursive JSON values.
  // Rebase them to the single contracts.json document without changing rules.
  const rebase = (value) => {
    if (Array.isArray(value)) return value.map(rebase);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$id').map(([key, child]) =>
      [key, key === '$ref' ? child.replace(/^urn:pkw:native:([^#]+)(?:#(.*))?$/, (_, name, pointer = '') => `#/schemas/${name}${pointer}`) : rebase(child)]));
  };
  return rebase(exported);
}
