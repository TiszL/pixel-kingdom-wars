// lifecycle.cases.mjs: the web port's engine lifecycle pins (patches.md P11/P13); this entry lets `node --test` load it
// with the shared TypeScript compiled (node-ts.support.mjs; worldv2/realm/patches.md P5).
import './node-ts.support.mjs';
await import('./lifecycle.cases.mjs');
