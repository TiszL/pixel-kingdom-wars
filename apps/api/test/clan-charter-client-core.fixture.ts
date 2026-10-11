import {it} from 'vitest';
import {actualCharterSalesCoreJourney} from './fixtures/charterSalesCore';
it('executes independent browser approvals and exact client-facade deliveries through actual Core mint and sale',async()=>{await actualCharterSalesCoreJourney({clientFacade:true});},600000);
