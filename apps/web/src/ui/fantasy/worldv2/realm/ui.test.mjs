// ui.cases.mjs is the concept's ui.test.mjs at 8acdf059; this entry lets `node --test` load it
// with the shared TypeScript compiled (node-ts.support.mjs; worldv2/realm/patches.md P5).
import './node-ts.support.mjs';
await import('./ui.cases.mjs');
