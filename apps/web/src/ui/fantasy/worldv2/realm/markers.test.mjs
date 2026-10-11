// markers.cases.mjs: the web port's P8 tests for bases.mjs (patches.md); this entry lets `node --test` load it
// with the shared TypeScript compiled (node-ts.support.mjs; worldv2/realm/patches.md P5).
import './node-ts.support.mjs';
await import('./markers.cases.mjs');
