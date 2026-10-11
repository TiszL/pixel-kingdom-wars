/** Combined E2/E4 pure and mocked fixture checks; no DB global setup. */
import {defineConfig} from 'vitest/config';
export default defineConfig({test:{
  include:['test/fleet-journey-economy-profile.test.ts','test/fleet-journey-economy-seed.test.ts','test/fleet-journey-debug-wake.test.ts'],
  globalSetup:[],setupFiles:[],environment:'node',fileParallelism:false,maxWorkers:1,
}});
