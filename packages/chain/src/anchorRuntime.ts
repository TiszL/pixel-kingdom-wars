/** The one interop boundary for Anchor's runtime members (BN, BorshCoder, ...).
 *
 * Anchor 0.32 ships CommonJS only, marked `__esModule`, with no `default` export.
 * - Native Node ESM / Vitest / `node --import tsx` ESM files: the namespace's
 *   `.default` is `module.exports` (the full runtime), while the detected named
 *   exports miss the BN re-export. This is what the old default import read.
 * - tsx compiling a file reached through require() (programs/*.ts are CJS, so
 *   every chain module they import is compiled to CJS): esbuild's __toESM honours
 *   `__esModule`, so a default import is `undefined` and a module-load
 *   `const {BorshCoder}=anchorPkg` threw. That broke every phase-e-programs run
 *   since 5660388d3 (run 37503885236, lifecycle-prepare). There the namespace
 *   itself carries every runtime member.
 * Prefer `.default` and fall back to the namespace: identical to the old import
 * wherever it worked, and correct where it did not. */
import * as anchorNamespace from '@coral-xyz/anchor';

type AnchorRuntime = typeof anchorNamespace;
export const anchorRuntime: AnchorRuntime =
  (anchorNamespace as unknown as { default?: AnchorRuntime }).default ?? anchorNamespace;
