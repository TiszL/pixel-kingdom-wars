/** Isolated author tests only; intentionally no shared-DB globalSetup. */
import { defineConfig } from 'vitest/config';
export default defineConfig({test:{
  include:['test/fleet-journey-economy-profile.test.ts','test/fleet-journey-economy-seed.test.ts'],
  fileParallelism:false,
}});
