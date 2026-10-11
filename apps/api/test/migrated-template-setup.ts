/** Per-file hook (vitest setupFiles). If an earlier file changed the shared runtime groups,
 * build the fresh-database template for the new state here, under the 60 s hook budget,
 * not inside the first 30 s case that asks for a fresh database (test/migratedTemplate.ts).
 * Otherwise it is one catalog query. */
import { beforeAll, vi } from 'vitest';
import { migratedTemplateReady, prepareMigratedTemplate } from './migratedTemplate';

type Client = typeof import('../src/db/client');
type Migrate = typeof import('../src/db/migrate');

beforeAll(async () => {
  if (await migratedTemplateReady()) return;
  // A file that mocks the database modules never creates a fresh database, and a build
  // here would call its mocks (mining-publication-mount asserts createDb is never called).
  const [client, migrate] = await Promise.all([import('../src/db/client'), import('../src/db/migrate')]);
  const [realClient, realMigrate] = await Promise.all([
    vi.importActual<Client>('../src/db/client'), vi.importActual<Migrate>('../src/db/migrate')]);
  if (client.createDb !== realClient.createDb || migrate.runMigrations !== realMigrate.runMigrations) return;
  await prepareMigratedTemplate();
});
