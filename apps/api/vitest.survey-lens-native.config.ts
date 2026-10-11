/** Explicit native Lens integration fixture, never part of ordinary CI discovery. */
import {defineConfig,mergeConfig} from 'vitest/config';
import base from './vitest.config';
export default mergeConfig(base,defineConfig({test:{include:['test/survey-lens-native.fixture.ts'],testTimeout:300000}}));
