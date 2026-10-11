/** One JS owner for the bridge's attribute-only viewport rules (419baf51 R3,
 * e9c1eb73 W10). These are design dimensions, not gameplay tuning. */
export type PkViewportClass = 'phone-portrait' | 'phone-landscape' | 'tablet-portrait' | 'tablet-landscape' | 'desktop';

export function classifyPkViewport(width: number, height: number): { vp: PkViewportClass; short: boolean } {
  const landscape = width > height;
  const vp = landscape && height <= 480 ? 'phone-landscape'
    : width >= 1200 ? 'desktop'
    : width >= 768 ? (landscape ? 'tablet-landscape' : 'tablet-portrait')
    : 'phone-portrait';
  return { vp, short: landscape && height <= 359 };
}

export function stampPkViewport(
  root: { dataset: { pkVp?: string; pkVpHeight?: string } }, width: number, height: number,
): PkViewportClass {
  const { vp, short } = classifyPkViewport(width, height);
  if (root.dataset.pkVp !== vp) root.dataset.pkVp = vp;
  if (short) {
    if (root.dataset.pkVpHeight !== 'short') root.dataset.pkVpHeight = 'short';
  } else if (root.dataset.pkVpHeight !== undefined) delete root.dataset.pkVpHeight;
  return vp;
}
