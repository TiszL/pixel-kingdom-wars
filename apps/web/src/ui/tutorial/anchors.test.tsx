/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { findAnchor } from './anchors';

const rect = (left = 40, top = 60, width = 120, height = 44): DOMRect => ({
  x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
  toJSON: () => ({}),
});
let control: HTMLButtonElement;
beforeEach(() => {
  control = document.createElement('button');
  control.dataset.onboardingCta = '';
  document.body.append(control);
  vi.spyOn(control, 'getBoundingClientRect').mockReturnValue(rect());
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(control);
});
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const spec = { selector: '[data-onboarding-cta]' };

it('rings a visible, hittable control', () => {
  expect(findAnchor(spec)).toBe(control);
});
it('skips a hidden first match and finds the live control', () => {
  const hidden = control.cloneNode() as HTMLButtonElement;
  hidden.hidden = true;
  document.body.prepend(hidden);
  expect(findAnchor(spec)).toBe(control);
});
it('rejects a control covered by an open sheet', () => {
  const sheet = document.createElement('div');
  document.body.append(sheet);
  vi.mocked(document.elementFromPoint).mockReturnValue(sheet);
  expect(findAnchor(spec)).toBeNull();
});
it('rejects disabled actions and zero-size targets', () => {
  control.disabled = true;
  expect(findAnchor(spec)).toBeNull();
  control.disabled = false;
  vi.mocked(control.getBoundingClientRect).mockReturnValue(rect(40, 60, 0, 0));
  expect(findAnchor(spec)).toBeNull();
});
it('rejects a card clipped outside its horizontal scroller', () => {
  const scroller = document.createElement('div');
  scroller.style.overflowX = 'auto';
  document.body.append(scroller);
  scroller.append(control);
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(300, 60, 100, 44));
  expect(findAnchor(spec)).toBeNull();
});
it('rejects offscreen targets even when a stale hit test returns them', () => {
  vi.mocked(control.getBoundingClientRect).mockReturnValue(rect(-200, 60));
  expect(findAnchor(spec)).toBeNull();
});
