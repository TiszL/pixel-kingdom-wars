/** Explicit owned DB/validator acceptance using already reviewed purpose-9 ELFs. */
import {defineConfig,mergeConfig} from 'vitest/config';
import base from './vitest.config';
export default mergeConfig(base,defineConfig({test:{include:['test/clan-charter-retirement-core.fixture.ts'],testTimeout:600000}}));
