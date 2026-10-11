import { defineConfig, type UserConfig } from 'vite';
import base from '../vite.config';

// The candidate builder passes only explicit public variables. Never borrow
// production .env values from the working tree while producing this test build.
export default defineConfig(async environment => ({
  ...await (typeof base === 'function' ? base(environment) : base) as UserConfig,
  envDir: false,
}));
