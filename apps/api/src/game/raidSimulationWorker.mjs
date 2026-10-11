// Worker threads do not inherit tsx's main-thread registration. Install the
// public programmatic loader before dynamically importing the TypeScript entry.
import { register } from 'tsx/esm/api';

register();
await import('./raidSimulationWorker.ts');
