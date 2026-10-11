export interface RuntimeFileCatalogEntry {
  id: string;
  loop: boolean;
  outputFile: string;
  runtimeTargetName: string;
}

/** Catalog-scoped technical repairs allowed to publish a WAV derivative. */
export const TECHNICAL_POST_PROCESS_BY_EXPORT_ID = Object.freeze({
  sfx_defense_mortar_impact_v3: Object.freeze({
    kind: 'trim_trailing_silence' as const,
    retainTailSeconds: 0.08,
    maximumTrimSeconds: 0.8,
    minimumTechnicalScore: 80,
  }),
});

export type TechnicalPostProcessPolicy =
  (typeof TECHNICAL_POST_PROCESS_BY_EXPORT_ID)[keyof typeof TECHNICAL_POST_PROCESS_BY_EXPORT_ID];

export function technicalPostProcessPolicy(
  entry: Pick<RuntimeFileCatalogEntry, 'id' | 'loop'>,
): TechnicalPostProcessPolicy | null {
  if (entry.loop) return null;
  return TECHNICAL_POST_PROCESS_BY_EXPORT_ID[
    entry.id as keyof typeof TECHNICAL_POST_PROCESS_BY_EXPORT_ID
  ] ?? null;
}

export function promotedRuntimeFile(entry: RuntimeFileCatalogEntry): string {
  return entry.loop || technicalPostProcessPolicy(entry) ? entry.runtimeTargetName : entry.outputFile;
}
