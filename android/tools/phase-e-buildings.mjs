// Phase E M41 (source #125) adds five DARK building types, listed in constants.PHASE_E_BUILDINGS.types, with
// STRUCTURES rows. The release source carries no bld_<type>_l<n> sprites for them: their approved art (workshop, lodge,
// market, harvester realm/tier variants, berths) lives under art/source/phase-e/ on the Phase E lane's branch
// phase-e-preserved-20260924 and is wired only by that lane. This exporter has no Phase E service catalogue (--phase-e-services
// lives only on the Phase E native client line, which D-153.48 keeps out of code 26), so a pack from such a source
// omits those types from its building catalogue, and only while the source ships them dark: the API default of
// PHASE_E_BUILDINGS_ENABLED, read from the committed config schema, must be 'false'. Anything else throws.
export const PHASE_E_FLAG = 'PHASE_E_BUILDINGS_ENABLED';
export const PHASE_E_FLAG_SCHEMA = 'apps/api/src/config.ts';

export function phaseEFlagDefault(configText) {
  const matches = [...configText.matchAll(/^\s*PHASE_E_BUILDINGS_ENABLED:\s*z\.enum\(\[\s*'true',\s*'false'\s*\]\)\.default\('([^']*)'\)/gm)];
  if (matches.length !== 1) throw new Error(`Cannot determine the ${PHASE_E_FLAG} default in ${PHASE_E_FLAG_SCHEMA} (${matches.length} schema declarations)`);
  return matches[0][1];
}

// Returns the building kinds a pack without Phase E services exports, and the omitted dark types (undefined when the
// source has no Phase E buildings, so older sources export byte-identical packs and their config is never read).
export function nonServicesBuildingKinds(constants, readConfig) {
  const kinds = { ...constants.STRUCTURES, ...constants.DEFENSES };
  const types = constants.PHASE_E_BUILDINGS?.types;
  if (types === undefined) return { kinds };
  if (!Array.isArray(types) || types.length === 0) throw new Error('PHASE_E_BUILDINGS.types must list the dark building types');
  const flag = phaseEFlagDefault(readConfig());
  if (flag !== 'false') {
    throw new Error(`Source lists PHASE_E_BUILDINGS but ${PHASE_E_FLAG} defaults to '${flag}' in ${PHASE_E_FLAG_SCHEMA}; `
      + 'a pack without Phase E services may omit these buildings only while they ship dark');
  }
  return { kinds: Object.fromEntries(Object.entries(kinds).filter(([type]) => !types.includes(type))), omitted: [...types] };
}
