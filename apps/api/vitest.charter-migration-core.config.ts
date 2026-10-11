/** One exclusive DB/validator run against the accepted unchanged purpose-9 ELFs. */
import {defineConfig,mergeConfig} from 'vitest/config';
import base from './vitest.config';
export default mergeConfig(base,defineConfig({test:{include:['test/clan-charter-migration-core.fixture.ts'],testTimeout:600000}}));
