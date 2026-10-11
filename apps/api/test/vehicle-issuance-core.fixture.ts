import {afterEach,it,vi} from 'vitest';
import {actualVehicleIssuanceAcquisition} from './fixtures/vehicleIssuance';
afterEach(()=>vi.unstubAllEnvs());
it('pairs actual original craft issuance with immutable acquisition and existing Core burn installation',async()=>{
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');
 await actualVehicleIssuanceAcquisition();
},600000);
