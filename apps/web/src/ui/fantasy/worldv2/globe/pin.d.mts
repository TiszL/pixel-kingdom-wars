/** The world pin (native GlobeV2Pin.PIN). */
export const PIN: string;
export const GEO_W: number;
export const GEO_H: number;
/** Presentation constants of the concept globe (camera, gestures, labels); no game numbers. */
export const P: Readonly<Record<string, number>>;
export interface GlobeRealmSpec { readonly id: string; readonly name: string; readonly lon: number; readonly lat: number; readonly accent: number }
export interface GlobeIslandSpec extends GlobeRealmSpec { readonly rx: number; readonly ry: number; readonly wDeg: number; readonly aspect: number }
/** The eight realms in the frozen geography's order (seeker-reach is shown as "Solana Reach"). */
export const REALMS: readonly GlobeRealmSpec[];
/** Seeker Island, Solana Island, Divine Isle at native's coordinates (drawn only with phaseEIslands). */
export const PHASE_E: readonly GlobeIslandSpec[];
export const ISLE: Readonly<{ CELL: number; ATLAS: number; EXTENT: number; DOWNSCALE: number; MAX: number }>;
