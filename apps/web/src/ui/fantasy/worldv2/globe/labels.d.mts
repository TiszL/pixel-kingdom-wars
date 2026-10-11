import type { GlobeRect, GlobeLabelAnchor } from './globe.d.mts';
/** Place one label (w × h) at its anchor, nudged off rects and the screen edges; null when nothing fits. */
export function placeLabel(anchor: readonly [number, number], w: number, h: number, rects: readonly GlobeRect[], W: number, H: number): [number, number] | null;
/** Place a frame's anchors in order; each placed label joins the rects. */
export function placeLabels<A extends GlobeLabelAnchor>(anchors: readonly A[], sizeOf: (a: A) => readonly [number, number], rects: readonly GlobeRect[], W: number, H: number): Array<A & { left: number; top: number }>;
