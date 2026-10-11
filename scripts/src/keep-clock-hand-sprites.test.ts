import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_KEEP_CLOCK_HAND_FILE,
  KEEP_CLOCK_HAND_BYTES_PER_FRAME,
  KEEP_CLOCK_HAND_CELL_PX,
  KEEP_CLOCK_HAND_FRAME_COUNT,
  generateKeepClockHandMasks,
  generatedKeepClockHandModule,
} from './keep-clock-hand-sprites';

const bit = (bytes: Uint8Array, frame: number, x: number, y: number): number => {
  const index = y * KEEP_CLOCK_HAND_CELL_PX + x;
  return (bytes[frame * KEEP_CLOCK_HAND_BYTES_PER_FRAME + (index >> 3)]! >> (index & 7)) & 1;
};

describe('KEEP clock hand sprite generator', () => {
  it('keeps the committed runtime masks byte-identical to the deterministic generator', async () => {
    expect(await readFile(GENERATED_KEEP_CLOCK_HAND_FILE, 'utf8'))
      .toBe(generatedKeepClockHandModule());
  });

  it('emits sixty non-empty binary masks with a stable mechanical pin', () => {
    const masks = generateKeepClockHandMasks();
    const expectedBytes = KEEP_CLOCK_HAND_BYTES_PER_FRAME * KEEP_CLOCK_HAND_FRAME_COUNT;
    expect(masks.hour).toHaveLength(expectedBytes);
    expect(masks.minute).toHaveLength(expectedBytes);
    const centre = Math.floor(KEEP_CLOCK_HAND_CELL_PX / 2);
    for (const mask of [masks.hour, masks.minute]) {
      for (let frame = 0; frame < KEEP_CLOCK_HAND_FRAME_COUNT; frame++) {
        expect(bit(mask, frame, centre, centre)).toBe(1);
        expect(mask.slice(frame * KEEP_CLOCK_HAND_BYTES_PER_FRAME,
          (frame + 1) * KEEP_CLOCK_HAND_BYTES_PER_FRAME).some((value) => value !== 0)).toBe(true);
      }
    }
  });

  it('pins the exact crisp sprite payload so algorithm drift is reviewed', () => {
    const masks = generateKeepClockHandMasks();
    const digest = createHash('sha256').update(masks.hour).update(masks.minute).digest('hex');
    expect(digest).toBe('9733a917f1b3be486a6e6a7431f212b04c1258001a2340c85a78e8674c936314');
  });
});
