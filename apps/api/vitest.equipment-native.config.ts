/** Explicit opt-in: requires the separate local native checkout and JDK/SDK. */
import {defineConfig,mergeConfig} from 'vitest/config';
import base from './vitest.config';
export default mergeConfig(base,defineConfig({test:{include:['test/ordinary-equipment-native.fixture.ts'],testTimeout:300000}}));
