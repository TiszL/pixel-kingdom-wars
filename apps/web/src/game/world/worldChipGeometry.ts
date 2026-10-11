/** Shared App-pixel → world-pixel geometry for chips stacked above structures. */

/** Builder job text begins 26 authored App pixels above the structure top. */
export function jobChipTextTopOffset(T: number): number {
  return 26 * (T / 32);
}

/** The job panel begins two authored App pixels above its text. */
export function jobChipPanelTopOffset(T: number): number {
  return 28 * (T / 32);
}

/** Visual top of a Phaser sprite whose `y` is its authored origin point. */
export function spriteVisualTopY(
  spriteY: number,
  originY: number,
  displayHeight: number,
): number {
  return spriteY - originY * displayHeight;
}
