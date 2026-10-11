/** P0 viewport source: game UI dimensions (including native toolbar clearance),
 * one pure classifier, attribute-only CSS and the existing viewport event bus. */
import { useSyncExternalStore } from 'react';
import { readGameUiViewport, subscribeGameViewport } from '../../lib/gameViewport';
import { classifyPkViewport, stampPkViewport } from './viewportClass';
import type { PkViewport } from './p2Types';

const SERVER: PkViewport = { vp: 'phone-portrait', w: 0, h: 0, dpr: 1, short: false };
let cached = SERVER;
export function readPkViewport(): PkViewport {
  if (typeof window === 'undefined') return SERVER;
  const { w, h } = readGameUiViewport();
  const { vp, short } = classifyPkViewport(w, h);
  stampPkViewport(document.documentElement, w, h);
  const dpr = window.devicePixelRatio || 1;
  if (vp !== cached.vp || short !== cached.short || w !== cached.w || h !== cached.h || dpr !== cached.dpr) cached = { vp, w, h, dpr, short };
  return cached;
}
export function usePkViewport(): PkViewport {
  return useSyncExternalStore(subscribeGameViewport, readPkViewport, () => SERVER);
}
