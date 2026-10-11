/** Latest-boundary snapshot for tests that replay a superseded migration file.
 *
 * WHY (2026-10-10, CI run 37503885235): production never re-executes an applied
 * file — the migrator compares hashes and applies each journal entry once
 * (src/db/migrate.ts). Several suites still replay an OLD file on purpose to
 * prove the downgrade fails closed, then used to replay 0256/0257 to "restore the
 * latest boundary". Since 0278 added the workshop trigger to those sealed
 * relations and 0279 superseded both seals with bound_cosmetic_return_contract
 * (successor-aware replay, dd92d0f16), 0256/0257 themselves refuse with
 * *_RETURN_SOURCE_CHANGED. The downgraded bodies then stayed installed in the
 * SHARED test database and every later file in the shard failed
 * (survey-lens -> training-presets). A replay test must instead put back the
 * exact catalog it found and prove it did.
 *
 * capture() records every public function, trigger, constraint, index and
 * grant plus the retained seal/contract rows; restore() reinstalls only what a
 * replay changed (functions keep their OIDs via CREATE OR REPLACE, so seals that
 * reference trigger function OIDs stay valid). Callers assert
 * `expect(await capture(sql)).toEqual(before)` and run the newest whole-system
 * seal check, shardkeep_divine_fragment_source(), so a restore that silently
 * missed an object fails loudly instead of leaking into later files. */
import type {Sql} from 'postgres';

type Row=Record<string,unknown>;
export type LatestBoundary={functions:Row[];triggers:Row[];constraints:Row[];indexes:Row[];relations:Row[];columns:Row[];seals:Record<string,unknown>};

// Effective grants (NULL = the type's default) drive the repair; raw acl_text is what seals compare.
const acl=(column:string)=>`(select jsonb_agg(jsonb_build_array(case when x.grantee=0 then 'PUBLIC' else x.grantee::regrole::text end,x.privilege_type,x.is_grantable) order by x.grantee,x.privilege_type,x.grantor) from aclexplode(${column}) x)`;

export async function captureLatestBoundary(sql:Sql):Promise<LatestBoundary>{
 const functions=await sql.unsafe(`select p.oid::regprocedure::text signature,p.proowner::regrole::text owner,p.proacl::text acl_text,${acl(`coalesce(p.proacl,acldefault('f',p.proowner))`)} acl,pg_get_functiondef(p.oid) definition
  from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in('f','p') order by 1`);
 const triggers=await sql.unsafe(`select c.relname relation,t.tgname name,t.tgenabled enabled,pg_get_triggerdef(t.oid) definition
  from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by 1,2`);
 const constraints=await sql.unsafe(`select c.relname relation,k.conname name,k.contype kind,pg_get_constraintdef(k.oid) definition
  from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace='public'::regnamespace order by 1,2`);
 const indexes=await sql.unsafe(`select indexname name,indexdef definition from pg_indexes where schemaname='public' order by 1`);
 const relations=await sql.unsafe(`select c.relname name,c.relkind kind,c.relowner::regrole::text owner,c.relacl::text acl_text,${acl(`coalesce(c.relacl,acldefault(case c.relkind when 'S' then 's'::"char" else 'r'::"char" end,c.relowner))`)} acl
  from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in('r','v','m','S','p') order by 1`);
 const columns=await sql.unsafe(`select c.relname relation,a.attname name,a.attacl::text acl_text,${acl('a.attacl')} acl
  from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='public'::regnamespace and a.attnum>0 and not a.attisdropped and a.attacl is not null order by 1,2`);
 // Same retained-source rule as advanced-expedition-boundary: seal/contract rows are immutable.
 const sealTables=await sql.unsafe(`select c.relname from pg_class c join pg_attribute a on a.attrelid=c.oid
  where c.relnamespace='public'::regnamespace and c.relkind='r' and a.attname in('record','source_sha256') and a.attnum>0 and not a.attisdropped
  and (right(c.relname,9)='_contract' or right(c.relname,5)='_seal') order by 1`);
 const seals:Record<string,unknown>={};
 for(const {relname} of sealTables)seals[relname as string]=await sql.unsafe(`select row_to_json(t)::text row from public.${relname as string} t order by 1`);
 return {functions,triggers,constraints,indexes,relations,columns,seals};
}

const key=(row:Row,...fields:string[])=>fields.map(f=>String(row[f])).join('\u0000');
const ident=(name:unknown)=>'"'+String(name).replaceAll('"','""')+'"';
type Grant=[string,string,boolean];

/** Reinstall exactly the captured catalog. Runs in one transaction as the owner. */
export async function restoreLatestBoundary(sql:Sql,before:LatestBoundary):Promise<void>{
 const now=await captureLatestBoundary(sql);
 await sql.begin(async tx=>{
  const run=(statement:string)=>tx.unsafe(statement);
  // Triggers a replay added or redefined go first so no stale trigger points at a function being replaced.
  const wantedTriggers=new Map(before.triggers.map(t=>[key(t,'relation','name'),t]));
  for(const t of now.triggers){const want=wantedTriggers.get(key(t,'relation','name'));
   if(!want||want.definition!==t.definition)await run(`drop trigger ${ident(t.name)} on public.${ident(t.relation)}`);}
  const wantedFunctions=new Map(before.functions.map(f=>[String(f.signature),f]));
  const currentFunctions=new Map(now.functions.map(f=>[String(f.signature),f]));
  for(const f of before.functions){const current=currentFunctions.get(String(f.signature));
   if(!current||current.definition!==f.definition)await run(String(f.definition));
   if(!current||current.acl_text!==f.acl_text)await regrant(run,`function public.${String(f.signature).replace(/^public\./,'')}`,current?.acl as Grant[]|null,f.acl as Grant[]|null);}
  for(const t of before.triggers){const current=now.triggers.find(c=>key(c,'relation','name')===key(t,'relation','name'));
   const recreated=!current||current.definition!==t.definition;if(recreated)await run(String(t.definition));
   const mode={O:'enable',D:'disable',R:'enable replica',A:'enable always'}[String(t.enabled)];
   if(recreated?t.enabled!=='O':current!.enabled!==t.enabled)await run(`alter table public.${ident(t.relation)} ${mode} trigger ${ident(t.name)}`);}
  for(const f of now.functions)if(!wantedFunctions.has(String(f.signature)))await run(`drop function public.${String(f.signature).replace(/^public\./,'')}`);
  const wantedConstraints=new Map(before.constraints.map(c=>[key(c,'relation','name'),c]));
  for(const c of now.constraints){const want=wantedConstraints.get(key(c,'relation','name'));
   if(!want||want.definition!==c.definition)await run(`alter table public.${ident(c.relation)} drop constraint ${ident(c.name)}`);}
  for(const c of before.constraints){const current=now.constraints.find(x=>key(x,'relation','name')===key(c,'relation','name'));
   if(!current||current.definition!==c.definition)await run(`alter table public.${ident(c.relation)} add constraint ${ident(c.name)} ${String(c.definition)}`);}
  for(const r of before.relations){const current=now.relations.find(x=>x.name===r.name);
   if(current&&current.acl_text!==r.acl_text)await regrant(run,`table public.${ident(r.name)}`,current.acl as Grant[]|null,r.acl as Grant[]|null);}
  for(const c of now.columns.concat(before.columns.filter(b=>!now.columns.some(n=>key(n,'relation','name')===key(b,'relation','name'))))){
   const want=before.columns.find(b=>key(b,'relation','name')===key(c,'relation','name'));
   const current=now.columns.find(n=>key(n,'relation','name')===key(c,'relation','name'));
   if(current?.acl_text!==want?.acl_text)await regrant(run,`table public.${ident(c.relation)}`,(current?.acl??null) as Grant[]|null,(want?.acl??null) as Grant[]|null,ident(c.name));}
 });
}

async function regrant(run:(s:string)=>Promise<unknown>,target:string,current:Grant[]|null,wanted:Grant[]|null,column?:string){
 const text=(g:Grant)=>g.join('\u0000');const want=new Set((wanted??[]).map(text)),have=new Set((current??[]).map(text));
 const on=(privilege:string)=>column?`${privilege}(${column}) on ${target}`:`${privilege} on ${target}`;
 const who=(grantee:string)=>grantee==='PUBLIC'?'public':ident(grantee);
 for(const g of current??[])if(!want.has(text(g)))await run(`revoke ${on(g[1])} from ${who(g[0])}`);
 for(const g of wanted??[])if(!have.has(text(g)))await run(`grant ${on(g[1])} to ${who(g[0])}${g[2]?' with grant option':''}`);
}
