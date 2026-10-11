import {sql} from 'drizzle-orm';
import type {createDb} from '../../src/db/client';
/** The inherited earned-material fixture installs its own sealed clock after
 * migrations. Rebind this additive test seal once, before any request artifact,
 * only in an empty disposable loopback database. No production guard changes. */
export async function resealVehicleRequestFixture(conn:ReturnType<typeof createDb>):Promise<void>{
 if(!conn.sql.options.host.every(host=>['localhost','127.0.0.1','::1'].includes(host)))throw new Error('vehicle request fixture requires loopback');
 await conn.db.transaction(async tx=>{
  const [identity]=await tx.execute<{name:string;n:number}>(sql`select current_database() name,((select count(*) from public.vehicle_request_issuance_attempts)+(select count(*) from public.vehicle_request_preparations)+(select count(*) from public.vehicle_request_signed_wires))::int n`);
  if(!identity||!/^\w+_test$/.test(identity.name)||identity.n!==0)throw new Error('vehicle request fixture requires empty disposable DB');
  await tx.execute(sql`select public.shardkeep_divine_fragment_source()`);
  const [contract]=await tx.execute<{record:unknown}>(sql`select public.shardkeep_vehicle_request_contract() record`);
  if(!contract)throw new Error('missing vehicle request fixture source');
  // Capture enabled-trigger bytes; restore the exact enabled state in this
  // transaction before testing the new source or creating any request.
  await tx.execute(sql`alter table public.vehicle_request_preparation_contract disable trigger vehicle_request_preparation_contract_guard`);
  await tx.execute(sql`update public.vehicle_request_preparation_contract set record=${JSON.stringify(contract.record)}::jsonb where singleton`);
  await tx.execute(sql`alter table public.vehicle_request_preparation_contract enable trigger vehicle_request_preparation_contract_guard`);
  await tx.execute(sql`select public.shardkeep_vehicle_request_source()`);
 });
}
