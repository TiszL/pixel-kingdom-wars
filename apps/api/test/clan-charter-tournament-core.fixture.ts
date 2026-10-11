import {it} from 'vitest';
import {actualCharterSalesCoreJourney} from './fixtures/charterSalesCore';
import {actualCharterTournamentCoreBeforeSale} from './fixtures/charterTournamentCore';
it('delivers independently approved tournament set and clear through real Core state, then completes a fresh client sale without changing tournament history',async()=>{
 await actualCharterSalesCoreJourney({clientFacade:true,tournament:actualCharterTournamentCoreBeforeSale});
},600000);
