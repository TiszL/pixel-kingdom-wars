import {afterEach,it,vi} from 'vitest';
import {actualVehicleRequestCore} from './fixtures/vehicleRequestCore';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it('delivers the retained earned-material wallet wire once despite lost acknowledgement and recovers actual SBF outcomes',actualVehicleRequestCore,600000);
