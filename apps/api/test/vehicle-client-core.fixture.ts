import {afterEach,it,vi} from 'vitest';
import {actualVehicleClientCoreJourney} from './fixtures/vehicleClientCore';
afterEach(()=>vi.unstubAllEnvs());
it('executes actual ordinary Core initial and service burns through original client APIs',async()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');await actualVehicleClientCoreJourney();},600000);
