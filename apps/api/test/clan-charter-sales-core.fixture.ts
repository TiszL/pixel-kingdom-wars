import {it} from 'vitest';
import {actualCharterSalesCoreJourney} from './fixtures/charterSalesCore';

it('settles server-created sale terms through real Core and both wallet signatures before projecting paid history, leader and secret',async()=>{
 await actualCharterSalesCoreJourney();
},600000);
