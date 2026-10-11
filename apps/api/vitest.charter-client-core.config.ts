/** Explicit local DB/Core acceptance; cached reviewed ELFs are not CI inputs. */
import {defineConfig,mergeConfig} from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(base,defineConfig({test:{
 include:['test/clan-charter-client-core.fixture.ts'],
 testTimeout:600000,
}}));
