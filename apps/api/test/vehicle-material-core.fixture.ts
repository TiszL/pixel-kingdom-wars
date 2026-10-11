import {afterEach,it,vi} from 'vitest';
import {actualVehicleMaterialCore} from './fixtures/vehicleMaterialCore';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it('consumes genuinely earned original vehicle materials only on actual paid SBF outcomes and continues the winning original through Core installation',()=>actualVehicleMaterialCore(),600000);
