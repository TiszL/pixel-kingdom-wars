import type { BaseVisualContext, RealmId } from './baseVisual';

/** Presentation-only feature seats in the immutable revision2 source plane.
 * Registered against the eight final512px PixelLab conversions on September15,
 * expressed in the published1536px nearest-scaled plane. Width/height bound
 * visible landmark accents, without extra images or fullscreen texture updates.
 * These seats never define collision, placement, ownership or simulation data. */
export type GroundFeatureKind = 'water' | 'ice' | 'crystal' | 'vent' | 'foliage' | 'waterfall' | 'dust' | 'mist';
export interface GroundEnvironmentFeature { kind: GroundFeatureKind; x: number; y: number; seed: number; width: number; height: number }
type Seat = readonly [GroundFeatureKind, number, number];
const seats: Record<RealmId, readonly Seat[]> = {
  frostveil: [['ice', 320, 120], ['ice', 470, 40], ['ice', 1300, 180], ['ice', 1400, 300], ['ice', 90, 1100], ['ice', 1420, 1120], ['ice', 1180, 1450], ['ice', 300, 1410]],
  elderwood: [['foliage', 150, 140], ['foliage', 480, 170], ['foliage', 980, 135], ['foliage', 1350, 240], ['foliage', 160, 560], ['foliage', 1400, 550], ['foliage', 175, 1110], ['foliage', 1420, 1100], ['foliage', 460, 1390], ['foliage', 1130, 1390]],
  sunscar: [['dust', 170, 220], ['dust', 465, 155], ['dust', 1190, 270], ['dust', 230, 650], ['dust', 1260, 730], ['dust', 250, 1250], ['dust', 1110, 1270], ['dust', 1320, 1450]],
  crownlands: [['water', 200, 135], ['water', 95, 250], ['water', 40, 440], ['water', 1470, 1140], ['water', 1410, 1350], ['water', 1120, 1460], ['water', 80, 1370], ['water', 250, 1510], ['foliage', 135, 330], ['foliage', 1360, 1170], ['foliage', 380, 1460], ['foliage', 1160, 1370]],
  'seeker-reach': [['crystal', 80, 88], ['crystal', 1450, 100], ['crystal', 350, 230], ['crystal', 1300, 330], ['crystal', 140, 620], ['crystal', 1390, 550], ['crystal', 140, 1390], ['crystal', 1390, 1390], ['crystal', 525, 1380], ['crystal', 1000, 1390]],
  stormcairn: [['water', 1420, 170], ['water', 1470, 235], ['foliage', 165, 290], ['foliage', 740, 210], ['foliage', 1310, 420], ['foliage', 250, 870], ['foliage', 1330, 870], ['foliage', 920, 1330], ['mist', 110, 120], ['mist', 1380, 225], ['mist', 125, 1330], ['mist', 1410, 1300]],
  thornwake: [['waterfall', 1435, 105], ['waterfall', 1430, 155], ['water', 1415, 210], ['water', 1460, 218], ['foliage', 200, 130], ['foliage', 550, 145], ['foliage', 1080, 140], ['foliage', 150, 540], ['foliage', 1400, 520], ['foliage', 180, 1030], ['foliage', 1400, 1090], ['foliage', 520, 1380], ['foliage', 1060, 1410]],
  cinderfall: [['vent', 270, 280], ['vent', 650, 120], ['vent', 885, 120], ['vent', 118, 815], ['vent', 194, 815], ['vent', 1350, 738], ['vent', 270, 1275], ['vent', 1345, 1350], ['mist', 650, 83], ['mist', 880, 70], ['mist', 180, 760]],
};
// Authored accent extents in source pixels, not gameplay distances or collision.
const extents: Record<GroundFeatureKind, readonly [number, number]> = {
  water: [36, 12], ice: [20, 20], crystal: [30, 42], vent: [24, 60],
  foliage: [42, 27], waterfall: [24, 105], dust: [96, 12], mist: [120, 30],
};
export const GROUND_ENVIRONMENT_REVISION_2 = {
  sourceSize: 1536,
  features: Object.fromEntries(Object.entries(seats).map(([realm, points]) => [realm,
    points.map(([kind, x, y], index) => ({ kind, x, y, seed: index + 1, width: extents[kind][0], height: extents[kind][1] })),
  ])) as Record<RealmId, GroundEnvironmentFeature[]>,
} as const;

/** Missing/legacy revisions deliberately retain their existing colour evidence. */
export function groundEnvironmentFeatures(context: BaseVisualContext): readonly GroundEnvironmentFeature[] | undefined {
  return context.artVersion === 2 && context.groundRevision === 2
    ? GROUND_ENVIRONMENT_REVISION_2.features[context.realmId] : undefined;
}
