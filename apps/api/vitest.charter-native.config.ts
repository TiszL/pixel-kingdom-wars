/** Explicit local native pairing; never discovered in ordinary API CI. */
import {defineConfig,mergeConfig} from 'vitest/config';
import base from './vitest.config';
export default mergeConfig(base,defineConfig({test:{include:['test/clan-charter-native.fixture.ts'],testTimeout:600000}}));
