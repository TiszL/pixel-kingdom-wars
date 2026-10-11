/** Compatibility entry points share P0's single viewport owner. */
import { usePkViewport } from './usePkViewport';
export type { PkViewportClass } from './viewportClass';
export function usePkViewportClass(): import('./viewportClass').PkViewportClass { return usePkViewport().vp; }
export function useDevicePixelRatio(): number { return usePkViewport().dpr; }
