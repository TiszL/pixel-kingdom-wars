/** Approval identity is checked before opening a database connection. */
export interface FantasyMigrationOperatorOptions {
  apply: boolean; manifestPath: string; expectedManifestHash: string; expectedBuildSha: string;
}
export function parseFantasyMigrationOperatorArgs(args: readonly string[]): FantasyMigrationOperatorOptions {
  const values = new Map<string, string>(); let apply = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === '--apply' && !apply) { apply = true; continue; }
    if (!['--manifest', '--expected-manifest-hash', '--expected-build-sha'].includes(key)
      || values.has(key) || !args[index + 1] || args[index + 1]!.startsWith('--')) {
      throw new Error('Expected [--apply] --manifest FILE --expected-manifest-hash SHA256 --expected-build-sha GIT_SHA');
    }
    values.set(key, args[++index]!);
  }
  const manifestPath = values.get('--manifest'); const expectedManifestHash = values.get('--expected-manifest-hash');
  const expectedBuildSha = values.get('--expected-build-sha');
  if (!manifestPath || !expectedManifestHash || !/^[a-f0-9]{64}$/.test(expectedManifestHash)
    || !expectedBuildSha || !/^[a-f0-9]{40}$/.test(expectedBuildSha)) throw new Error('Explicit manifest and full approval hashes are required');
  return { apply, manifestPath, expectedManifestHash, expectedBuildSha };
}
export function assertFantasyMigrationOperator(options: FantasyMigrationOperatorOptions, context: {
  manifestHash: string; buildSha: string; gitSha: string | null; gitDirty: boolean;
  fantasyEnabled: string | undefined; multiBaseEnabled: string | undefined;
}): void {
  if (context.manifestHash !== options.expectedManifestHash) throw new Error('Fantasy manifest approval hash mismatch');
  // Packaged API images have a build stamp and no .git; source invocations have
  // a checkout. When both exist they must agree. Never accept the dev fallback.
  const stamped = /^[a-f0-9]{40}$/.test(context.buildSha) ? context.buildSha : null;
  if ((!stamped && !context.gitSha) || (stamped && stamped !== options.expectedBuildSha)
    || (context.gitSha && context.gitSha !== options.expectedBuildSha)) throw new Error('Actual build does not match approved SHA');
  if (options.apply && context.gitDirty) throw new Error('Apply requires an unchanged approved checkout');
  if (context.fantasyEnabled !== 'false' || context.multiBaseEnabled !== 'true') {
    throw new Error('Stage compatible code with fantasy sales explicitly disabled before applying');
  }
}
