import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/fleet-journey-debug-wake.test.ts'],fileParallelism:false}});
