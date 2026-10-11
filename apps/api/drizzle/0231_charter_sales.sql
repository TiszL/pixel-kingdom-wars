-- D153.176 ordinary-only prospective Charter sale source and durable saga.
-- Existing source/roster/chest guard replacements are S5-held, never live authority.
SET LOCAL lock_timeout='10s';
-- A rerun may validate our complete schema, never adopt a partially existing
-- or owner-created lookalike as durable source evidence.
DO $$DECLARE tab text;found_any boolean:=false;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_sale_epochs','charter_sale_clan_inserts','charter_sale_births','charter_sale_heads','charter_sales','charter_sale_inventory_heads','charter_sale_fence_origins','charter_sale_acceptances','charter_sale_attempts','charter_sale_preparations','charter_sale_wires','charter_sale_terminals','charter_sale_fence_releases','charter_sale_effects','charter_sale_ante_posts','charter_sale_ante_entries','charter_sale_ante_effects','charter_sale_raid_admissions','charter_sale_raid_outcomes'] LOOP
  IF to_regclass('public.'||tab) IS NOT NULL THEN found_any:=true;END IF;
 END LOOP;
 IF found_any THEN
  FOREACH tab IN ARRAY ARRAY['charter_sale_epochs','charter_sale_clan_inserts','charter_sale_births','charter_sale_heads','charter_sales','charter_sale_inventory_heads','charter_sale_fence_origins','charter_sale_acceptances','charter_sale_attempts','charter_sale_preparations','charter_sale_wires','charter_sale_terminals','charter_sale_fence_releases','charter_sale_effects','charter_sale_ante_posts','charter_sale_ante_entries','charter_sale_ante_effects','charter_sale_raid_admissions','charter_sale_raid_outcomes'] LOOP
   IF to_regclass('public.'||tab) IS NULL OR obj_description(to_regclass('public.'||tab),'pg_class') IS DISTINCT FROM 'D153.176 charter-sales-v1'
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SCHEMA';END IF;
  END LOOP;
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.charter_sale_epochs(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),id uuid NOT NULL UNIQUE,domain jsonb NOT NULL,policy jsonb NOT NULL,
 source_id uuid NOT NULL REFERENCES public.clan_charter_event_source(source_id),rule_id uuid NOT NULL REFERENCES public.clan_charter_raid_tithe_rules(id),
 enrolled_at timestamptz NOT NULL CHECK(isfinite(enrolled_at)),contract text NOT NULL CHECK(contract='ordinary-monotone-d175-v1')
);
CREATE TABLE IF NOT EXISTS public.charter_sale_clan_inserts(
 clan_id uuid PRIMARY KEY,reservation_id uuid NOT NULL UNIQUE REFERENCES public.charter_creation_reservations(id),
 epoch_id uuid NOT NULL REFERENCES public.charter_sale_epochs(id),post_id uuid NOT NULL UNIQUE REFERENCES public.charter_creation_terminal_posts(ledger_id),
 original_clan jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_births(
 clan_id uuid PRIMARY KEY,reservation_id uuid NOT NULL UNIQUE REFERENCES public.charter_creation_reservations(id),
 terminal_id uuid NOT NULL UNIQUE REFERENCES public.charter_creation_terminals(id),epoch_id uuid NOT NULL REFERENCES public.charter_sale_epochs(id),
 tx_key text NOT NULL,creation jsonb NOT NULL,original_terminal jsonb NOT NULL,born_at timestamptz NOT NULL CHECK(isfinite(born_at))
);
CREATE TABLE IF NOT EXISTS public.charter_sale_heads(
 clan_id uuid PRIMARY KEY REFERENCES public.charter_sale_births(clan_id),leader_wallet text NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 0 AND 4294967295),last_sale_id uuid
);
CREATE TABLE IF NOT EXISTS public.charter_sales(
 id uuid PRIMARY KEY,seller text NOT NULL,idempotency_key text NOT NULL,request jsonb NOT NULL,original jsonb NOT NULL,
 clan_id uuid NOT NULL REFERENCES public.charter_sale_births(clan_id),buyer text NOT NULL,tx_key text NOT NULL,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),UNIQUE(seller,idempotency_key)
);
CREATE TABLE IF NOT EXISTS public.charter_sale_inventory_heads(
 sale_id uuid PRIMARY KEY REFERENCES public.charter_sales(id),revision integer NOT NULL CHECK(revision IN(0,1)),
 count integer NOT NULL CHECK(count=revision),tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_fence_origins(
 fence_id uuid PRIMARY KEY REFERENCES public.clan_charter_member_fences(id),tx_key text NOT NULL,original_fence jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_acceptances(
 sale_id uuid PRIMARY KEY REFERENCES public.charter_sales(id),fence_id uuid NOT NULL UNIQUE REFERENCES public.clan_charter_member_fences(id),
 terms_hash text NOT NULL,buyer_base_id uuid NOT NULL,buyer_authority jsonb NOT NULL,freshness_ms integer NOT NULL CHECK(freshness_ms>0),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_attempts(
 sale_id uuid PRIMARY KEY REFERENCES public.charter_sales(id),id uuid NOT NULL UNIQUE,record jsonb NOT NULL,source jsonb NOT NULL,
 buyer_authority jsonb NOT NULL,freshness_ms integer NOT NULL,recorded_at timestamptz NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_preparations(
 sale_id uuid PRIMARY KEY REFERENCES public.charter_sale_attempts(sale_id),record jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_wires(
 sale_id uuid PRIMARY KEY REFERENCES public.charter_sale_preparations(sale_id),record jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_terminals(
 sale_id uuid PRIMARY KEY REFERENCES public.charter_sales(id),id uuid NOT NULL UNIQUE,outcome text NOT NULL CHECK(outcome IN('completed','cancelled')),
 record jsonb NOT NULL,inventory jsonb NOT NULL,source jsonb NOT NULL,clan_before jsonb NOT NULL,clan_after jsonb NOT NULL,
 roster_before jsonb NOT NULL,roster_after jsonb NOT NULL,tx_key text NOT NULL,completed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_fence_releases(
 fence_id uuid PRIMARY KEY REFERENCES public.clan_charter_member_fences(id),sale_id uuid NOT NULL UNIQUE REFERENCES public.charter_sale_terminals(sale_id),
 terminal_id uuid NOT NULL UNIQUE REFERENCES public.charter_sale_terminals(id),payment_source jsonb,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_effects(
 sale_id uuid NOT NULL REFERENCES public.charter_sale_terminals(sale_id),kind text NOT NULL,target text NOT NULL,
 before_row jsonb,after_row jsonb,tx_key text NOT NULL,PRIMARY KEY(sale_id,kind,target)
);
-- Capture actual original ante money and terminal disposition since enrollment.
CREATE TABLE IF NOT EXISTS public.charter_sale_ante_posts(
 ledger_id uuid PRIMARY KEY REFERENCES public.ledger_transactions(id),epoch_id uuid NOT NULL REFERENCES public.charter_sale_epochs(id),
 original_transaction jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_ante_entries(
 entry_id bigint PRIMARY KEY REFERENCES public.ledger_entries(id),ledger_id uuid NOT NULL REFERENCES public.charter_sale_ante_posts(ledger_id),
 original_entry jsonb NOT NULL,account_identity jsonb NOT NULL,before_balance bigint NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_ante_effects(
 entry_id bigint PRIMARY KEY REFERENCES public.charter_sale_ante_entries(entry_id),before_account jsonb NOT NULL,after_account jsonb NOT NULL,tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_raid_admissions(
 raid_id uuid PRIMARY KEY REFERENCES public.clan_charter_raid_events(raid_id),epoch_id uuid NOT NULL REFERENCES public.charter_sale_epochs(id),
 event jsonb NOT NULL,original_raid jsonb NOT NULL,keep_level integer NOT NULL,ante_amount bigint NOT NULL CHECK(ante_amount>=0),
 ante_post uuid UNIQUE REFERENCES public.charter_sale_ante_posts(ledger_id),tx_key text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.charter_sale_raid_outcomes(
 raid_id uuid PRIMARY KEY REFERENCES public.charter_sale_raid_admissions(raid_id),before_raid jsonb NOT NULL,after_raid jsonb NOT NULL,
 live_state jsonb,observed_at timestamptz NOT NULL,tx_key text NOT NULL
);

-- Compile the literal table definitions into private temporary references only
-- for migration compatibility checking. They grant no source-writing capability,
-- preserve no facts, and are dropped immediately. Foreign keys are compared by
-- exact public identities independently (temporary tables cannot reference them).
DO $$DECLARE row_spec record;shadow text;actual jsonb;expected jsonb;fk jsonb;BEGIN
 FOR row_spec IN SELECT * FROM(VALUES
('charter_sale_epochs',$shape$
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),id uuid NOT NULL UNIQUE,domain jsonb NOT NULL,policy jsonb NOT NULL,
 source_id uuid NOT NULL,rule_id uuid NOT NULL,
 enrolled_at timestamptz NOT NULL CHECK(isfinite(enrolled_at)),contract text NOT NULL CHECK(contract='ordinary-monotone-d175-v1')
$shape$,'[{"column":"source_id","target":"clan_charter_event_source","targetColumn":"source_id"},{"column":"rule_id","target":"clan_charter_raid_tithe_rules","targetColumn":"id"}]'::jsonb),
('charter_sale_clan_inserts',$shape$
 clan_id uuid PRIMARY KEY,reservation_id uuid NOT NULL UNIQUE,
 epoch_id uuid NOT NULL,post_id uuid NOT NULL UNIQUE,
 original_clan jsonb NOT NULL,tx_key text NOT NULL
$shape$,'[{"column":"reservation_id","target":"charter_creation_reservations","targetColumn":"id"},{"column":"epoch_id","target":"charter_sale_epochs","targetColumn":"id"},{"column":"post_id","target":"charter_creation_terminal_posts","targetColumn":"ledger_id"}]'::jsonb),
('charter_sale_births',$shape$
 clan_id uuid PRIMARY KEY,reservation_id uuid NOT NULL UNIQUE,
 terminal_id uuid NOT NULL UNIQUE,epoch_id uuid NOT NULL,
 tx_key text NOT NULL,creation jsonb NOT NULL,original_terminal jsonb NOT NULL,born_at timestamptz NOT NULL CHECK(isfinite(born_at))
$shape$,'[{"column":"reservation_id","target":"charter_creation_reservations","targetColumn":"id"},{"column":"terminal_id","target":"charter_creation_terminals","targetColumn":"id"},{"column":"epoch_id","target":"charter_sale_epochs","targetColumn":"id"}]'::jsonb),
('charter_sale_heads',$shape$
 clan_id uuid PRIMARY KEY,leader_wallet text NOT NULL,
 revision bigint NOT NULL CHECK(revision BETWEEN 0 AND 4294967295),last_sale_id uuid
$shape$,'[{"column":"clan_id","target":"charter_sale_births","targetColumn":"clan_id"}]'::jsonb),
('charter_sales',$shape$
 id uuid PRIMARY KEY,seller text NOT NULL,idempotency_key text NOT NULL,request jsonb NOT NULL,original jsonb NOT NULL,
 clan_id uuid NOT NULL,buyer text NOT NULL,tx_key text NOT NULL,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),UNIQUE(seller,idempotency_key)
$shape$,'[{"column":"clan_id","target":"charter_sale_births","targetColumn":"clan_id"}]'::jsonb),
('charter_sale_inventory_heads',$shape$
 sale_id uuid PRIMARY KEY,revision integer NOT NULL CHECK(revision IN(0,1)),
 count integer NOT NULL CHECK(count=revision),tx_key text NOT NULL
$shape$,'[{"column":"sale_id","target":"charter_sales","targetColumn":"id"}]'::jsonb),
('charter_sale_fence_origins',$shape$
 fence_id uuid PRIMARY KEY,tx_key text NOT NULL,original_fence jsonb NOT NULL
$shape$,'[{"column":"fence_id","target":"clan_charter_member_fences","targetColumn":"id"}]'::jsonb),
('charter_sale_acceptances',$shape$
 sale_id uuid PRIMARY KEY,fence_id uuid NOT NULL UNIQUE,
 terms_hash text NOT NULL,buyer_base_id uuid NOT NULL,buyer_authority jsonb NOT NULL,freshness_ms integer NOT NULL CHECK(freshness_ms>0),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),tx_key text NOT NULL
$shape$,'[{"column":"sale_id","target":"charter_sales","targetColumn":"id"},{"column":"fence_id","target":"clan_charter_member_fences","targetColumn":"id"}]'::jsonb),
('charter_sale_attempts',$shape$
 sale_id uuid PRIMARY KEY,id uuid NOT NULL UNIQUE,record jsonb NOT NULL,source jsonb NOT NULL,
 buyer_authority jsonb NOT NULL,freshness_ms integer NOT NULL,recorded_at timestamptz NOT NULL,tx_key text NOT NULL
$shape$,'[{"column":"sale_id","target":"charter_sales","targetColumn":"id"}]'::jsonb),
('charter_sale_preparations',$shape$
 sale_id uuid PRIMARY KEY,record jsonb NOT NULL,tx_key text NOT NULL
$shape$,'[{"column":"sale_id","target":"charter_sale_attempts","targetColumn":"sale_id"}]'::jsonb),
('charter_sale_wires',$shape$
 sale_id uuid PRIMARY KEY,record jsonb NOT NULL,tx_key text NOT NULL
$shape$,'[{"column":"sale_id","target":"charter_sale_preparations","targetColumn":"sale_id"}]'::jsonb),
('charter_sale_terminals',$shape$
 sale_id uuid PRIMARY KEY,id uuid NOT NULL UNIQUE,outcome text NOT NULL CHECK(outcome IN('completed','cancelled')),
 record jsonb NOT NULL,inventory jsonb NOT NULL,source jsonb NOT NULL,clan_before jsonb NOT NULL,clan_after jsonb NOT NULL,
 roster_before jsonb NOT NULL,roster_after jsonb NOT NULL,tx_key text NOT NULL,completed_at timestamptz NOT NULL
$shape$,'[{"column":"sale_id","target":"charter_sales","targetColumn":"id"}]'::jsonb),
('charter_sale_fence_releases',$shape$
 fence_id uuid PRIMARY KEY,sale_id uuid NOT NULL UNIQUE,
 terminal_id uuid NOT NULL UNIQUE,payment_source jsonb,tx_key text NOT NULL
$shape$,'[{"column":"fence_id","target":"clan_charter_member_fences","targetColumn":"id"},{"column":"sale_id","target":"charter_sale_terminals","targetColumn":"sale_id"},{"column":"terminal_id","target":"charter_sale_terminals","targetColumn":"id"}]'::jsonb),
('charter_sale_effects',$shape$
 sale_id uuid NOT NULL,kind text NOT NULL,target text NOT NULL,
 before_row jsonb,after_row jsonb,tx_key text NOT NULL,PRIMARY KEY(sale_id,kind,target)
$shape$,'[{"column":"sale_id","target":"charter_sale_terminals","targetColumn":"sale_id"}]'::jsonb),
('charter_sale_ante_posts',$shape$
 ledger_id uuid PRIMARY KEY,epoch_id uuid NOT NULL,
 original_transaction jsonb NOT NULL,tx_key text NOT NULL
$shape$,'[{"column":"ledger_id","target":"ledger_transactions","targetColumn":"id"},{"column":"epoch_id","target":"charter_sale_epochs","targetColumn":"id"}]'::jsonb),
('charter_sale_ante_entries',$shape$
 entry_id bigint PRIMARY KEY,ledger_id uuid NOT NULL,
 original_entry jsonb NOT NULL,account_identity jsonb NOT NULL,before_balance bigint NOT NULL,tx_key text NOT NULL
$shape$,'[{"column":"entry_id","target":"ledger_entries","targetColumn":"id"},{"column":"ledger_id","target":"charter_sale_ante_posts","targetColumn":"ledger_id"}]'::jsonb),
('charter_sale_ante_effects',$shape$
 entry_id bigint PRIMARY KEY,before_account jsonb NOT NULL,after_account jsonb NOT NULL,tx_key text NOT NULL
$shape$,'[{"column":"entry_id","target":"charter_sale_ante_entries","targetColumn":"entry_id"}]'::jsonb),
('charter_sale_raid_admissions',$shape$
 raid_id uuid PRIMARY KEY,epoch_id uuid NOT NULL,
 event jsonb NOT NULL,original_raid jsonb NOT NULL,keep_level integer NOT NULL,ante_amount bigint NOT NULL CHECK(ante_amount>=0),
 ante_post uuid UNIQUE,tx_key text NOT NULL
$shape$,'[{"column":"raid_id","target":"clan_charter_raid_events","targetColumn":"raid_id"},{"column":"epoch_id","target":"charter_sale_epochs","targetColumn":"id"},{"column":"ante_post","target":"charter_sale_ante_posts","targetColumn":"ledger_id"}]'::jsonb),
('charter_sale_raid_outcomes',$shape$
 raid_id uuid PRIMARY KEY,before_raid jsonb NOT NULL,after_raid jsonb NOT NULL,
 live_state jsonb,observed_at timestamptz NOT NULL,tx_key text NOT NULL
$shape$,'[{"column":"raid_id","target":"charter_sale_raid_admissions","targetColumn":"raid_id"}]'::jsonb)) defs(tab,definition,foreign_keys) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||row_spec.tab) AND relkind='r'
   AND relpersistence='p' AND relowner=current_user::regrole::oid AND NOT relrowsecurity AND NOT relforcerowsecurity)
   OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=to_regclass('public.'||row_spec.tab))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SCHEMA';END IF;
  shadow:='charter_sale_shape_'||replace(gen_random_uuid()::text,'-','');
  EXECUTE format('CREATE TEMPORARY TABLE %I(%s) ON COMMIT DROP',shadow,row_spec.definition);
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
   a.attcollation,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO actual
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=to_regclass('public.'||row_spec.tab) AND a.attnum>0 AND NOT a.attisdropped;
  SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
   a.attcollation,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) INTO expected
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=to_regclass('pg_temp.'||shadow) AND a.attnum>0 AND NOT a.attisdropped;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SCHEMA';END IF;
  SELECT jsonb_agg(v ORDER BY v::text) INTO actual FROM(SELECT jsonb_build_array(q.contype,q.conkey,q.condeferrable,q.condeferred,q.convalidated,
   CASE WHEN q.contype='c' THEN pg_get_constraintdef(q.oid) ELSE NULL END) v FROM pg_constraint q
   WHERE q.conrelid=to_regclass('public.'||row_spec.tab) AND q.contype NOT IN('f','t')) fields;
  SELECT jsonb_agg(v ORDER BY v::text) INTO expected FROM(SELECT jsonb_build_array(q.contype,q.conkey,q.condeferrable,q.condeferred,q.convalidated,
   CASE WHEN q.contype='c' THEN pg_get_constraintdef(q.oid) ELSE NULL END) v FROM pg_constraint q
   WHERE q.conrelid=to_regclass('pg_temp.'||shadow)) fields;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SCHEMA';END IF;
  IF(SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public.'||row_spec.tab) AND contype='f')<>jsonb_array_length(row_spec.foreign_keys)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SCHEMA';END IF;
  FOR fk IN SELECT value FROM jsonb_array_elements(row_spec.foreign_keys) LOOP
   IF NOT EXISTS(SELECT 1 FROM pg_constraint q
    WHERE q.conrelid=to_regclass('public.'||row_spec.tab) AND q.contype='f' AND q.confrelid=to_regclass('public.'||(fk->>'target'))
     AND q.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=q.conrelid AND attname=fk->>'column')]::smallint[]
     AND q.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=q.confrelid AND attname=fk->>'targetColumn')]::smallint[]
     AND q.confupdtype='a' AND q.confdeltype='a' AND q.confmatchtype='s' AND NOT q.condeferrable AND NOT q.condeferred AND q.convalidated)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SCHEMA';END IF;
  END LOOP;
  EXECUTE format('DROP TABLE pg_temp.%I',shadow);
  EXECUTE format('COMMENT ON TABLE public.%I IS %L',row_spec.tab,'D153.176 charter-sales-v1');
 END LOOP;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.charter_sales'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_OWNER' USING ERRCODE='42501';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE v record;owner_id oid;
BEGIN
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.charter_sales'::regclass;
 IF current_setting('session_replication_role')<>'origin' OR NOT public.shardkeep_clan_charter_raid_chest_hooks()
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 FOR v IN
  SELECT tab,tab||suffix name,'shardkeep_charter_sale_private' fn,typ,false deferred,false definer FROM
   (VALUES('charter_sale_epochs'),('charter_sale_clan_inserts'),('charter_sale_births'),('charter_sale_heads'),('charter_sales'),('charter_sale_inventory_heads'),
    ('charter_sale_fence_origins'),('charter_sale_acceptances'),('charter_sale_attempts'),('charter_sale_preparations'),('charter_sale_wires'),
    ('charter_sale_terminals'),('charter_sale_fence_releases'),('charter_sale_effects'),('charter_sale_ante_posts'),('charter_sale_ante_entries'),('charter_sale_ante_effects'),('charter_sale_raid_admissions'),('charter_sale_raid_outcomes')) a(tab)
   CROSS JOIN(VALUES('_guard',31),('_no_truncate',34)) b(suffix,typ)
  UNION ALL SELECT tab,tab||'_charter_sale_capture','shardkeep_charter_sale_capture',5,false,true FROM
   (VALUES('charter_creation_terminals'),('charter_sales'),('clan_charter_member_fences'),('charter_sale_attempts'),('charter_sale_terminals')) a(tab)
  UNION ALL SELECT tab,tab||'_charter_sale_source','shardkeep_charter_sale_source',31,false,true FROM
   (VALUES('clans'),('clan_members'),('ledger_transactions'),('ledger_entries'),('accounts'),('raids')) a(tab)
  UNION ALL SELECT tab,tab||'_charter_sale_no_truncate','shardkeep_charter_sale_source',34,false,true FROM
   (VALUES('clans'),('clan_members'),('ledger_transactions'),('ledger_entries'),('accounts'),('raids')) a(tab)
  UNION ALL SELECT tab,tab||'_charter_sale_ante_capture','shardkeep_charter_sale_ante_capture',typ,false,true FROM
   (VALUES('ledger_transactions',5),('ledger_entries',5),('accounts',17),('clan_charter_raid_events',5),('raids',17)) ante(tab,typ)
  UNION ALL SELECT tab,tab||'_charter_sale_effect_capture','shardkeep_charter_sale_effect_capture',29,false,true FROM
   (VALUES('clans'),('clan_members'),('charter_sale_heads')) effects(tab)
  UNION ALL SELECT tab,tab||'_charter_sale_complete','shardkeep_charter_sale_complete',29,true,true FROM
   (VALUES('charter_sale_clan_inserts'),('charter_sale_births'),('charter_sales'),('charter_sale_inventory_heads'),('charter_sale_fence_origins'),('charter_sale_acceptances'),('charter_sale_attempts'),('charter_sale_preparations'),('charter_sale_wires'),('charter_sale_terminals'),('charter_sale_fence_releases'),('charter_sale_effects'),('charter_sale_heads'),('charter_sale_ante_posts'),('charter_sale_ante_entries'),('charter_sale_ante_effects'),('charter_sale_raid_admissions'),('charter_sale_raid_outcomes'),('ledger_transactions'),('ledger_entries'),('accounts'),('raids'),
    ('clans'),('clan_members'),('bases'),('base_slots'),('base_raid_locks'),('deed_ownership_observations')) a(tab)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=('public.'||v.tab)::regclass AND t.tgname=v.name
   AND t.tgtype=v.typ AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
   AND n.nspname='public' AND p.proname=v.fn AND p.pronargs=0 AND p.proowner=owner_id AND c.relowner=owner_id
   AND p.prosecdef=v.definer AND t.tgdeferrable=v.deferred AND t.tginitdeferred=v.deferred
   AND EXISTS(SELECT 1 FROM unnest(p.proconfig) cfg WHERE replace(cfg,' ','')='search_path=pg_catalog,public,pg_temp')
   AND(NOT v.deferred OR EXISTS(SELECT 1 FROM pg_constraint q WHERE q.oid=t.tgconstraint AND q.conrelid=t.tgrelid
    AND q.conname=t.tgname AND q.contype='t' AND q.condeferrable AND q.condeferred)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_birth(cid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b public.charter_sale_births%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;t public.charter_creation_terminals%ROWTYPE;
 e public.charter_sale_epochs%ROWTYPE;v jsonb;
BEGIN
 PERFORM public.shardkeep_charter_sale_hooks();SELECT * INTO b FROM public.charter_sale_births WHERE clan_id=cid;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 SELECT * INTO e FROM public.charter_sale_epochs WHERE id=b.epoch_id;
 SELECT * INTO r FROM public.charter_creation_reservations WHERE id=b.reservation_id FOR UPDATE NOWAIT;
 SELECT * INTO t FROM public.charter_creation_terminals WHERE id=b.terminal_id;
 IF e.id IS NULL OR t.id IS NULL OR to_jsonb(t) IS DISTINCT FROM b.original_terminal OR t.outcome<>'activated'
 OR r.state<>'activated' OR r.clan_id IS DISTINCT FROM cid OR t.reservation_id IS DISTINCT FROM r.id
 OR b.tx_key IS DISTINCT FROM t.tx_key OR NOT EXISTS(SELECT 1 FROM public.charter_sale_clan_inserts ci
  WHERE ci.clan_id=cid AND ci.reservation_id=r.id AND ci.epoch_id=e.id AND ci.tx_key=b.tx_key AND ci.original_clan=t.clan_snapshot)
 OR jsonb_build_object('genesisHash',r.consent->'chain'->'genesisHash','economyProgram',r.consent->'chain'->'economyProgram',
  'craftProgram',r.consent->'chain'->'craftProgram') IS DISTINCT FROM e.domain-'treasury'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 v:=public.shardkeep_charter_terminal_read(r.payer,r.intent_id,false);
 IF v IS NULL OR v->'result'->>'terminalId' IS DISTINCT FROM b.terminal_id::text
  OR v->'result'->>'state' IS DISTINCT FROM 'activated' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 RETURN b.creation;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_released(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_sale_fence_releases%ROWTYPE;t public.charter_sale_terminals%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;
BEGIN
 SELECT * INTO r FROM public.charter_sale_fence_releases WHERE fence_id=fid;IF NOT FOUND THEN RETURN false;END IF;
 PERFORM public.shardkeep_charter_sale_hooks();SELECT * INTO t FROM public.charter_sale_terminals WHERE sale_id=r.sale_id;
 SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=r.sale_id;
 IF t.id IS NULL OR t.id IS DISTINCT FROM r.terminal_id OR a.fence_id IS DISTINCT FROM fid OR r.tx_key IS DISTINCT FROM t.tx_key
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_ante_proof(rid uuid,terminal_required boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE a public.charter_sale_raid_admissions%ROWTYPE;ep public.charter_sale_epochs%ROWTYPE;
 p public.charter_sale_ante_posts%ROWTYPE;refund public.charter_sale_ante_posts%ROWTYPE;o public.charter_sale_raid_outcomes%ROWTYPE;
 t public.clan_charter_raid_terminals%ROWTYPE;source jsonb;entries jsonb;refund_entries jsonb;destination jsonb;amount bigint;classification text;
BEGIN
 PERFORM public.shardkeep_charter_sale_hooks();SELECT * INTO a FROM public.charter_sale_raid_admissions WHERE raid_id=rid;
 IF a.raid_id IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 SELECT * INTO ep FROM public.charter_sale_epochs WHERE id=a.epoch_id;
 IF ep.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_events e WHERE e.raid_id=rid AND to_jsonb(e)=a.event)
  OR a.event->>'source_id' IS DISTINCT FROM ep.source_id::text
  OR a.event->>'chest_admission_tx' IS DISTINCT FROM a.tx_key
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 IF a.event->>'kind' IN('campaign','pve') THEN amount:=0;
 ELSE amount:=(ep.policy->'anteSchedule'->>least(greatest(a.keep_level,1)-1,jsonb_array_length(ep.policy->'anteSchedule')-1))::bigint;END IF;
 IF a.ante_amount IS DISTINCT FROM amount OR(a.ante_post IS NULL) IS DISTINCT FROM(amount=0)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 IF amount>0 THEN
  SELECT * INTO p FROM public.charter_sale_ante_posts WHERE ledger_id=a.ante_post;
  IF p.epoch_id IS DISTINCT FROM ep.id OR p.tx_key IS DISTINCT FROM a.tx_key
   OR p.original_transaction->>'type' IS DISTINCT FROM 'raid.ante'
   OR p.original_transaction->>'idempotency_key' IS DISTINCT FROM 'raid-ante:'||(a.original_raid->>'idempotency_key')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  PERFORM public.shardkeep_charter_sale_ante_post(p.ledger_id);
  SELECT jsonb_agg(to_jsonb(e) ORDER BY e.entry_id) INTO entries FROM public.charter_sale_ante_entries e WHERE e.ledger_id=p.ledger_id;
  SELECT e.account_identity INTO source FROM public.charter_sale_ante_entries e WHERE e.ledger_id=p.ledger_id AND(e.original_entry->>'delta')::bigint=-amount;
  SELECT e.account_identity INTO destination FROM public.charter_sale_ante_entries e WHERE e.ledger_id=p.ledger_id AND(e.original_entry->>'delta')::bigint=amount;
  IF jsonb_array_length(entries)<>2 OR destination->>'kind' IS DISTINCT FROM 'shard_burn'
   OR destination->>'owner_wallet' IS NOT NULL OR destination->>'base_id' IS NOT NULL
   OR(a.original_raid->>'attacker_base_id' IS NULL AND(source->>'kind' IS DISTINCT FROM 'player_shards' OR source->>'owner_wallet' IS DISTINCT FROM a.event->>'attacker_wallet' OR source->>'base_id' IS NOT NULL))
   OR(a.original_raid->>'attacker_base_id' IS NOT NULL AND(source->>'kind' IS DISTINCT FROM 'base_shards' OR source->>'base_id' IS DISTINCT FROM a.event->>'attacker_base_id' OR source->>'owner_wallet' IS NOT NULL))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 END IF;
 SELECT * INTO o FROM public.charter_sale_raid_outcomes WHERE raid_id=rid;
 IF NOT terminal_required THEN RETURN jsonb_build_object('admission',to_jsonb(a),'post',to_jsonb(p),'entries',entries);END IF;
 SELECT * INTO t FROM public.clan_charter_raid_terminals WHERE raid_id=rid;
 IF o.raid_id IS NULL OR t.raid_id IS NULL OR o.before_raid IS DISTINCT FROM t.before_raid OR o.after_raid IS DISTINCT FROM t.after_raid
  OR o.tx_key IS DISTINCT FROM t.tx_key OR t.terminal_status NOT IN('resolved','expired')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_PENDING';END IF;
 SELECT * INTO refund FROM public.charter_sale_ante_posts WHERE original_transaction->>'idempotency_key'='raid-ante-refund:'||rid::text;
 IF amount=0 THEN
  IF refund.ledger_id IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;classification:='no-ante';
 ELSIF t.terminal_status='resolved' THEN
  IF refund.ledger_id IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;classification:='resolved-retained';
 ELSIF refund.ledger_id IS NOT NULL THEN
  PERFORM public.shardkeep_charter_sale_ante_post(refund.ledger_id);
  SELECT jsonb_agg(to_jsonb(e) ORDER BY e.entry_id) INTO refund_entries FROM public.charter_sale_ante_entries e WHERE e.ledger_id=refund.ledger_id;
  IF refund.tx_key IS DISTINCT FROM o.tx_key OR refund.original_transaction->>'type' IS DISTINCT FROM 'raid.ante.system_refund'
   OR refund.original_transaction->'metadata' IS DISTINCT FROM jsonb_build_object('raidId',rid,'wallet',a.event->>'attacker_wallet','originalKey',p.original_transaction->>'idempotency_key')
   OR jsonb_array_length(refund_entries)<>2 OR EXISTS(SELECT 1 FROM public.charter_sale_ante_entries e WHERE e.ledger_id=p.ledger_id
    AND NOT EXISTS(SELECT 1 FROM public.charter_sale_ante_entries reversed WHERE reversed.ledger_id=refund.ledger_id
      AND reversed.account_identity=e.account_identity AND(reversed.original_entry->>'delta')::bigint=-(e.original_entry->>'delta')::bigint))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;classification:='system-refunded';
 ELSE
  -- Absence alone is not a retained-ante terminal. This is the existing actual
  -- current-SIM ordinary batch abandonment predicate captured at transition.
  IF(o.before_raid->>'sim_version')::integer IS DISTINCT FROM(ep.policy->>'simVersion')::integer
   OR o.before_raid->>'simulation_lease_token' IS NOT NULL OR o.before_raid->>'simulation_system_attempted_at' IS NOT NULL
   OR(o.live_state IS NOT NULL AND(o.live_state->>'mode'='live' OR o.live_state->>'started_at' IS NOT NULL OR o.live_state->>'armed_at' IS NOT NULL))
   OR(o.before_raid->>'orders_deadline_at')::timestamptz+(ep.policy->>'batchGraceSeconds')::integer*interval '1 second'>=o.observed_at
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_AMBIGUOUS';END IF;classification:='ordinary-abandoned';
 END IF;
 RETURN jsonb_build_object('admission',to_jsonb(a),'post',to_jsonb(p),'entries',entries,'outcome',to_jsonb(o),
  'refund',to_jsonb(refund),'refundEntries',refund_entries,'classification',classification);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_ante_post(lid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p public.charter_sale_ante_posts%ROWTYPE;e public.charter_sale_ante_entries%ROWTYPE;effect public.charter_sale_ante_effects%ROWTYPE;
BEGIN
 SELECT * INTO p FROM public.charter_sale_ante_posts WHERE ledger_id=lid;
 IF p.ledger_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.ledger_transactions l WHERE l.id=lid AND to_jsonb(l)=p.original_transaction)
  OR(SELECT count(*) FROM public.ledger_entries WHERE txn_id=lid)<>2 OR(SELECT count(*) FROM public.charter_sale_ante_entries WHERE ledger_id=lid)<>2
  OR(SELECT sum((original_entry->>'delta')::numeric) FROM public.charter_sale_ante_entries WHERE ledger_id=lid) IS DISTINCT FROM 0::numeric
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 FOR e IN SELECT * FROM public.charter_sale_ante_entries WHERE ledger_id=lid LOOP
  SELECT * INTO effect FROM public.charter_sale_ante_effects WHERE entry_id=e.entry_id;
  IF e.tx_key IS DISTINCT FROM p.tx_key OR effect.tx_key IS DISTINCT FROM e.tx_key OR effect.entry_id IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.ledger_entries live WHERE live.id=e.entry_id AND to_jsonb(live)=e.original_entry)
   OR NOT EXISTS(SELECT 1 FROM public.accounts account WHERE account.id=(e.original_entry->>'account_id')::uuid AND to_jsonb(account)-'balance'=e.account_identity)
   OR e.account_identity->>'currency' IS DISTINCT FROM 'SHARDS' OR e.before_balance<0
   OR(e.original_entry->>'balance_after')::numeric IS DISTINCT FROM e.before_balance::numeric+(e.original_entry->>'delta')::numeric
   OR(effect.before_account-'balance') IS DISTINCT FROM e.account_identity OR(effect.after_account-'balance') IS DISTINCT FROM e.account_identity
   OR(effect.before_account->>'balance')::bigint IS DISTINCT FROM e.before_balance
   OR(effect.after_account->>'balance')::bigint IS DISTINCT FROM(e.original_entry->>'balance_after')::bigint
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_ante_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.charter_sale_ante_entries%ROWTYPE;cid uuid;
BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_NAME<>TG_TABLE_NAME||'_charter_sale_ante_capture' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
  OR NOT((TG_TABLE_NAME IN('ledger_transactions','ledger_entries','clan_charter_raid_events') AND TG_OP='INSERT')
   OR(TG_TABLE_NAME IN('accounts','raids') AND TG_OP='UPDATE')) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_READ_COMMITTED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.charter_sale_epochs) THEN RETURN NULL;END IF;
 PERFORM public.shardkeep_charter_sale_hooks();
 IF TG_TABLE_NAME='ledger_transactions' THEN
  IF NEW.type IN('raid.ante','raid.ante.system_refund') OR NEW.idempotency_key LIKE 'raid-ante:%' OR NEW.idempotency_key LIKE 'raid-ante-refund:%' THEN
   INSERT INTO public.charter_sale_ante_posts(ledger_id) VALUES(NEW.id);
  END IF;
 ELSIF TG_TABLE_NAME='ledger_entries' THEN
  IF EXISTS(SELECT 1 FROM public.charter_sale_ante_posts WHERE ledger_id=NEW.txn_id) THEN
   INSERT INTO public.charter_sale_ante_entries(entry_id) VALUES(NEW.id);
  END IF;
 ELSIF TG_TABLE_NAME='accounts' THEN
  FOR e IN SELECT * FROM public.charter_sale_ante_entries x WHERE x.tx_key=pg_current_xact_id()::text
   AND x.original_entry->>'account_id'=NEW.id::text AND NOT EXISTS(SELECT 1 FROM public.charter_sale_ante_effects done WHERE done.entry_id=x.entry_id) LOOP
   INSERT INTO public.charter_sale_ante_effects(entry_id,before_account,after_account) VALUES(e.entry_id,to_jsonb(OLD),to_jsonb(NEW));
  END LOOP;
 ELSIF TG_TABLE_NAME='clan_charter_raid_events' THEN
  INSERT INTO public.charter_sale_raid_admissions(raid_id) VALUES(NEW.raid_id);
 ELSIF TG_TABLE_NAME='raids' THEN
  IF OLD.status<>NEW.status AND NEW.status IN('resolved','expired') AND EXISTS(SELECT 1 FROM public.charter_sale_raid_admissions WHERE raid_id=NEW.id) THEN
   INSERT INTO public.charter_sale_raid_outcomes(raid_id,before_raid,after_raid) VALUES(NEW.id,to_jsonb(OLD),to_jsonb(NEW));
  END IF;
 END IF;RETURN NULL;
END $$;

-- Private durable attempt, finality and terminal projection.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_chain_original(sid uuid) RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('creation',s.original->'creation','sale',jsonb_build_object('id',s.id,'fenceId',s.original->'fenceId',
  'seller',s.seller,'buyer',s.buyer,'treasury',s.original->'domain'->'treasury','expectedRevision',s.original->'expectedRevision',
  'priceLamports',s.original->'priceLamports','termsHash',s.original->'termsHash')) FROM public.charter_sales s WHERE s.id=sid
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_pins(sid uuid,source jsonb) RETURNS boolean
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT coalesce(source->>'genesisHash'=s.original->'domain'->>'genesisHash'
  AND source->'programs'->>'expectedGenesisHash'=s.original->'domain'->>'genesisHash'
  AND source->'programs'->>'stateProvenance'='fresh-reviewed-deployment'
  AND jsonb_build_array(source->'programs'->'economy',source->'programs'->'craft',source->'programs'->'core')
   =b.original_terminal->'observation'->'mint'->'source'->'programs',false)
 FROM public.charter_sales s JOIN public.charter_sale_births b ON b.clan_id=s.clan_id WHERE s.id=sid
$$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_projection(tab text,before_row jsonb,after_row jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE t public.charter_sale_terminals%ROWTYPE;s public.charter_sales%ROWTYPE;old_member jsonb;new_member jsonb;
BEGIN
 FOR t IN SELECT * FROM public.charter_sale_terminals WHERE tx_key=pg_current_xact_id()::text AND outcome='completed' LOOP
  SELECT * INTO s FROM public.charter_sales WHERE id=t.sale_id;
  IF tab='clans' THEN
   IF before_row=t.clan_before AND after_row=t.clan_after THEN RETURN true;END IF;
  ELSIF tab='clan_members' THEN
   SELECT value INTO old_member FROM jsonb_array_elements(t.roster_before) WHERE value->>'player_wallet'=coalesce(before_row->>'player_wallet',after_row->>'player_wallet');
   SELECT value INTO new_member FROM jsonb_array_elements(t.roster_after) WHERE value->>'player_wallet'=coalesce(before_row->>'player_wallet',after_row->>'player_wallet');
   IF(old_member IS NOT NULL OR new_member IS NOT NULL) AND old_member IS NOT DISTINCT FROM before_row AND new_member IS NOT DISTINCT FROM after_row
    AND old_member IS DISTINCT FROM new_member THEN RETURN true;END IF;
  ELSIF tab='charter_sale_heads' THEN
   IF before_row->>'clan_id'=s.clan_id::text AND before_row->>'leader_wallet'=s.seller
    AND(before_row->>'revision')::bigint=(s.original->>'expectedRevision')::bigint
    AND after_row=jsonb_set(jsonb_set(jsonb_set(before_row,'{leader_wallet}',to_jsonb(s.buyer)),
     '{revision}',to_jsonb((s.original->>'expectedRevision')::bigint+1)),'{last_sale_id}',to_jsonb(s.id))
   THEN RETURN true;END IF;
  END IF;
 END LOOP;RETURN false;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_terminal(actor text,sid uuid,outcome_value text,proof jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;t public.charter_sale_terminals%ROWTYPE;h public.charter_sale_inventory_heads%ROWTYPE;
 a public.charter_sale_acceptances%ROWTYPE;v jsonb;
BEGIN
 PERFORM public.shardkeep_charter_sale_owner();PERFORM public.shardkeep_charter_sale_hooks();
 SELECT * INTO s FROM public.charter_sales WHERE id=sid;
 IF s.id IS NULL OR actor NOT IN(s.seller,s.buyer) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_NOT_FOUND';END IF;
 SELECT * INTO t FROM public.charter_sale_terminals WHERE sale_id=sid;
 IF t.sale_id IS NOT NULL THEN RETURN public.shardkeep_charter_sale_read(actor,sid);END IF;
 PERFORM 1 FROM public.players WHERE wallet IN(s.seller,s.buyer) ORDER BY wallet COLLATE "C" FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.charter_creation_reservations WHERE clan_id=s.clan_id FOR UPDATE NOWAIT;
 SELECT * INTO s FROM public.charter_sales WHERE id=sid FOR UPDATE NOWAIT;
 SELECT * INTO h FROM public.charter_sale_inventory_heads WHERE sale_id=sid FOR UPDATE NOWAIT;
 SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=sid FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.clans WHERE id=s.clan_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.charter_sale_heads WHERE clan_id=s.clan_id FOR UPDATE NOWAIT;
 LOCK TABLE public.clans,public.clan_members IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 INSERT INTO public.charter_sale_terminals(sale_id,outcome,record) VALUES(sid,outcome_value,proof);
 RETURN public.shardkeep_charter_sale_read(actor,sid);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_expiry(message text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE bytes bytea;value numeric:=0;i integer;
BEGIN
 IF message IS NULL OR length(message)<>322 OR message !~ '^[0-9a-f]+$' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 bytes:=decode(message,'hex');FOR i IN 0..7 LOOP value:=value+get_byte(bytes,121+i)::numeric*power(256::numeric,i);END LOOP;
 IF value<=0 OR value>9223372036854775807 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;RETURN value::bigint;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_clearance(sid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;h public.charter_sale_heads%ROWTYPE;
 f public.clan_charter_member_fences%ROWTYPE;payment jsonb;events jsonb:='[]'::jsonb;e record;
BEGIN
 PERFORM public.shardkeep_charter_sale_hooks();SELECT * INTO s FROM public.charter_sales WHERE id=sid;
 SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=sid;
 SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=s.clan_id;
 SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=a.fence_id;
 IF s.id IS NULL OR a.sale_id IS NULL OR f.id IS NULL OR h.leader_wallet IS DISTINCT FROM s.seller
  OR h.revision IS DISTINCT FROM(s.original->>'expectedRevision')::bigint OR public.shardkeep_charter_sale_released(f.id)
  OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=sid)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 PERFORM public.shardkeep_charter_sale_birth(s.clan_id);
 payment:=public.shardkeep_charter_member_payment_read(f.id,s.seller);
 IF payment IS NULL OR payment->>'totalShards' IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_UNPAID';END IF;
 FOR e IN SELECT raid_id FROM public.clan_charter_raid_events WHERE original_clan_id=s.clan_id ORDER BY clan_ordinal LOOP
  events:=events||jsonb_build_array(public.shardkeep_charter_sale_ante_proof(e.raid_id,true));
 END LOOP;
 IF jsonb_array_length(events)<>f.raid_ordinal THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 RETURN jsonb_build_object('head',to_jsonb(h),'fence',to_jsonb(f),'payment',payment,'raids',events);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_attempt(actor text,sid uuid,quote jsonb,elapsed_ms double precision,freshness integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;ep public.charter_sale_epochs%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_sale_owner();PERFORM public.shardkeep_charter_sale_hooks();
 SELECT * INTO s FROM public.charter_sales WHERE id=sid;
 IF s.id IS NULL OR actor NOT IN(s.seller,s.buyer) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_NOT_FOUND';END IF;
 IF EXISTS(SELECT 1 FROM public.charter_sale_attempts WHERE sale_id=sid) OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=sid)
 THEN RETURN public.shardkeep_charter_sale_read(actor,sid);END IF;
 SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=sid;
 PERFORM 1 FROM public.players WHERE wallet IN(s.seller,s.buyer) ORDER BY wallet COLLATE "C" FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.bases WHERE id=a.buyer_base_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.base_slots WHERE base_id=a.buyer_base_id ORDER BY wallet,slot FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.deed_ownership_observations WHERE base_id=a.buyer_base_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.base_raid_locks WHERE base_id=a.buyer_base_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.raids WHERE attacker_base_id=a.buyer_base_id AND status IN('pending_orders','resolving') ORDER BY id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.charter_creation_reservations WHERE clan_id=s.clan_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.charter_sales WHERE id=sid FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.charter_sale_inventory_heads WHERE sale_id=sid FOR UPDATE NOWAIT;
 LOCK TABLE public.clans,public.clan_members,public.base_slots,public.bases,public.deed_ownership_observations,public.base_raid_locks,public.raids IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.clans WHERE id=s.clan_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.charter_sale_heads WHERE clan_id=s.clan_id FOR UPDATE NOWAIT;
 -- A losing concurrent proposal is history only. It cannot replace or extend.
 IF EXISTS(SELECT 1 FROM public.charter_sale_attempts WHERE sale_id=sid) THEN RETURN public.shardkeep_charter_sale_read(actor,sid);END IF;
 SELECT * INTO ep FROM public.charter_sale_epochs;
 IF elapsed_ms IS NULL OR elapsed_ms<0 OR elapsed_ms>(ep.policy->>'observationMaxAgeMs')::double precision
  OR elapsed_ms='NaN'::double precision THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_STALE';END IF;
 INSERT INTO public.charter_sale_attempts(sale_id,record,freshness_ms)
 VALUES(sid,jsonb_build_object('quote',quote,'elapsedMs',elapsed_ms),freshness);
 RETURN public.shardkeep_charter_sale_read(actor,sid);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_preparation(actor text,sid uuid,attempt_id uuid,value jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_sale_owner();PERFORM public.shardkeep_charter_sale_hooks();
 SELECT * INTO s FROM public.charter_sales WHERE id=sid FOR UPDATE NOWAIT;
 IF s.id IS NULL OR actor NOT IN(s.seller,s.buyer) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_NOT_FOUND';END IF;
 IF EXISTS(SELECT 1 FROM public.charter_sale_preparations WHERE sale_id=sid) OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=sid)
 THEN RETURN public.shardkeep_charter_sale_read(actor,sid);END IF;
 IF NOT EXISTS(SELECT 1 FROM public.charter_sale_attempts WHERE sale_id=sid AND id=attempt_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 INSERT INTO public.charter_sale_preparations(sale_id,record) VALUES(sid,value);RETURN public.shardkeep_charter_sale_read(actor,sid);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_wire(actor text,sid uuid,value jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_sale_owner();PERFORM public.shardkeep_charter_sale_hooks();
 SELECT * INTO s FROM public.charter_sales WHERE id=sid FOR UPDATE NOWAIT;
 IF s.id IS NULL OR actor NOT IN(s.seller,s.buyer) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_NOT_FOUND';END IF;
 IF EXISTS(SELECT 1 FROM public.charter_sale_wires WHERE sale_id=sid) OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=sid)
 THEN RETURN public.shardkeep_charter_sale_read(actor,sid);END IF;
 INSERT INTO public.charter_sale_wires(sale_id,record) VALUES(sid,value);RETURN public.shardkeep_charter_sale_read(actor,sid);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_effect_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE before_value jsonb;after_value jsonb;t public.charter_sale_terminals%ROWTYPE;target_value text;
BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_TABLE_NAME NOT IN('clans','clan_members','charter_sale_heads')
 OR TG_NAME<>TG_TABLE_NAME||'_charter_sale_effect_capture' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN before_value:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN after_value:=to_jsonb(NEW);END IF;
 IF public.shardkeep_charter_sale_projection(TG_TABLE_NAME,before_value,after_value) THEN
  PERFORM public.shardkeep_charter_sale_hooks();
  FOR t IN SELECT terminal.* FROM public.charter_sale_terminals terminal JOIN public.charter_sales deal ON deal.id=terminal.sale_id
   WHERE terminal.tx_key=pg_current_xact_id()::text AND terminal.outcome='completed'
    AND deal.clan_id::text=coalesce(after_value->>'clan_id',before_value->>'clan_id',after_value->>'id',before_value->>'id') LOOP
   target_value:=CASE WHEN TG_TABLE_NAME='clan_members' THEN coalesce(after_value->>'player_wallet',before_value->>'player_wallet')
    ELSE coalesce(after_value->>'clan_id',before_value->>'clan_id',after_value->>'id',before_value->>'id') END;
   INSERT INTO public.charter_sale_effects(sale_id,kind,target,before_row,after_row) VALUES(t.sale_id,TG_TABLE_NAME,target_value,before_value,after_value);
  END LOOP;
 END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_terminal_history(sid uuid,committing boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE t public.charter_sale_terminals%ROWTYPE;s public.charter_sales%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;
 member record;head_before jsonb;head_after jsonb;actual jsonb;n integer:=0;
BEGIN
 SELECT * INTO t FROM public.charter_sale_terminals WHERE sale_id=sid;
 SELECT * INTO s FROM public.charter_sales WHERE id=sid;
 SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=sid;
 IF t.sale_id IS NULL OR s.id IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 IF a.sale_id IS NOT NULL THEN
  IF NOT public.shardkeep_charter_sale_released(a.fence_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 ELSIF EXISTS(SELECT 1 FROM public.charter_sale_fence_releases WHERE sale_id=sid) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 IF t.outcome='completed' THEN
  head_before:=t.source->'head';head_after:=jsonb_set(jsonb_set(jsonb_set(head_before,'{leader_wallet}',to_jsonb(s.buyer)),
   '{revision}',to_jsonb((s.original->>'expectedRevision')::bigint+1)),'{last_sale_id}',to_jsonb(s.id));
  IF NOT EXISTS(SELECT 1 FROM public.charter_sale_effects fx WHERE fx.sale_id=sid AND fx.kind='clans' AND fx.target=s.clan_id::text
    AND fx.before_row=t.clan_before AND fx.after_row=t.clan_after AND fx.tx_key=t.tx_key)
   OR NOT EXISTS(SELECT 1 FROM public.charter_sale_effects fx WHERE fx.sale_id=sid AND fx.kind='charter_sale_heads' AND fx.target=s.clan_id::text
    AND fx.before_row=head_before AND fx.after_row=head_after AND fx.tx_key=t.tx_key)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
  FOR member IN SELECT coalesce(old_value->>'player_wallet',new_value->>'player_wallet') wallet,old_value,new_value FROM
   jsonb_array_elements(t.roster_before) old_members(old_value) FULL JOIN jsonb_array_elements(t.roster_after) new_members(new_value)
    ON old_value->>'player_wallet'=new_value->>'player_wallet' WHERE old_value IS DISTINCT FROM new_value LOOP
   IF NOT EXISTS(SELECT 1 FROM public.charter_sale_effects fx WHERE fx.sale_id=sid AND fx.kind='clan_members' AND fx.target=member.wallet
     AND fx.before_row IS NOT DISTINCT FROM member.old_value AND fx.after_row IS NOT DISTINCT FROM member.new_value AND fx.tx_key=t.tx_key)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;n:=n+1;
  END LOOP;n:=n+2;
  IF committing THEN
   SELECT to_jsonb(live) INTO actual FROM public.clans live WHERE id=s.clan_id;
   IF actual IS DISTINCT FROM t.clan_after THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
   SELECT coalesce(jsonb_agg(to_jsonb(live) ORDER BY live.player_wallet COLLATE "C"),'[]'::jsonb) INTO actual FROM public.clan_members live WHERE clan_id=s.clan_id;
   IF actual IS DISTINCT FROM t.roster_after THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
   SELECT to_jsonb(live) INTO actual FROM public.charter_sale_heads live WHERE clan_id=s.clan_id;
   IF actual IS DISTINCT FROM head_after THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
  END IF;
 ELSE
  IF t.clan_before IS DISTINCT FROM t.clan_after OR t.roster_before IS DISTINCT FROM t.roster_after
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END IF;
 IF(SELECT count(*) FROM public.charter_sale_effects WHERE sale_id=sid)<>n THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_historical_fence(fid uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE release public.charter_sale_fence_releases%ROWTYPE;f public.clan_charter_member_fences%ROWTYPE;t public.charter_sale_terminals%ROWTYPE;roster jsonb;
BEGIN
 IF NOT public.shardkeep_charter_sale_released(fid) THEN RETURN false;END IF;
 SELECT * INTO release FROM public.charter_sale_fence_releases WHERE fence_id=fid;
 SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=fid;
 SELECT * INTO t FROM public.charter_sale_terminals WHERE sale_id=release.sale_id;
 PERFORM public.shardkeep_charter_sale_terminal_history(t.sale_id,false);
 SELECT coalesce(jsonb_agg(original_membership ORDER BY member_wallet COLLATE "C"),'[]'::jsonb) INTO roster FROM public.clan_charter_member_roster WHERE fence_id=fid;
 IF roster IS DISTINCT FROM t.roster_before OR f.original_clan-'chest_shards' IS DISTINCT FROM t.clan_before-'chest_shards'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 IF release.payment_source IS NOT NULL THEN PERFORM public.shardkeep_charter_member_payment_read(fid,f.actor_wallet);END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE ep public.charter_sale_epochs%ROWTYPE;r public.charter_creation_reservations%ROWTYPE;t public.charter_creation_terminals%ROWTYPE;
 b public.charter_sale_births%ROWTYPE;h public.charter_sale_heads%ROWTYPE;s public.charter_sales%ROWTYPE;f public.clan_charter_member_fences%ROWTYPE;
 ledger public.ledger_transactions%ROWTYPE;leg public.ledger_entries%ROWTYPE;account public.accounts%ROWTYPE;
 ante_post public.charter_sale_ante_posts%ROWTYPE;ante_entry public.charter_sale_ante_entries%ROWTYPE;
 raid public.raids%ROWTYPE;event public.clan_charter_raid_events%ROWTYPE;expected_metadata jsonb;
 acceptance public.charter_sale_acceptances%ROWTYPE;attempt public.charter_sale_attempts%ROWTYPE;preparation public.charter_sale_preparations%ROWTYPE;
 wire public.charter_sale_wires%ROWTYPE;terminal public.charter_sale_terminals%ROWTYPE;payment public.clan_charter_member_payments%ROWTYPE;
 inventory_head public.charter_sale_inventory_heads%ROWTYPE;quote jsonb;receipt jsonb;expected_receipt jsonb;royalty numeric;actual jsonb;
 origin public.charter_sale_fence_origins%ROWTYPE;c public.clans%ROWTYPE;p public.charter_creation_terminal_posts%ROWTYPE;creation jsonb;terms jsonb;bid uuid;
BEGIN
 IF TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END) OR TG_WHEN<>'BEFORE'
 OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 OR TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_TRIGGER';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_READ_COMMITTED';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.charter_sales'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_OWNER' USING ERRCODE='42501';END IF;
 PERFORM public.shardkeep_charter_sale_hooks();
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='charter_sale_heads' THEN
   IF public.shardkeep_charter_sale_projection('charter_sale_heads',to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
  ELSIF TG_TABLE_NAME='charter_sale_inventory_heads' THEN
   SELECT * INTO attempt FROM public.charter_sale_attempts WHERE sale_id=OLD.sale_id;
   IF OLD.revision=0 AND OLD.count=0 AND attempt.id IS NOT NULL AND attempt.tx_key=pg_current_xact_id()::text
    AND NEW.sale_id=OLD.sale_id AND NEW.revision=1 AND NEW.count=1 AND NEW.tx_key=attempt.tx_key THEN RETURN NEW;END IF;
  END IF;
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='charter_sale_epochs' THEN
  LOCK TABLE public.clans,public.clan_members,public.raids,public.ledger_transactions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.raids WHERE status NOT IN('resolved','expired')) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  IF NEW.domain IS NULL OR NEW.domain IS DISTINCT FROM jsonb_build_object('genesisHash',NEW.domain->'genesisHash',
   'economyProgram',NEW.domain->'economyProgram','craftProgram',NEW.domain->'craftProgram','treasury',NEW.domain->'treasury')
   OR jsonb_typeof(NEW.policy) IS DISTINCT FROM 'object' OR NOT(NEW.policy ?& ARRAY['rosterCap','anteSchedule','royaltyBps','basisPoints','simVersion','batchGraceSeconds','observationMaxAgeMs','titheBps'])
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.singleton:=true;NEW.id:=gen_random_uuid();NEW.enrolled_at:=clock_timestamp();NEW.contract:='ordinary-monotone-d175-v1';
  SELECT source_id INTO STRICT NEW.source_id FROM public.clan_charter_event_source;
  SELECT id INTO STRICT NEW.rule_id FROM public.clan_charter_raid_tithe_rules WHERE source_id=NEW.source_id;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_clan_inserts' THEN
  SELECT * INTO ep FROM public.charter_sale_epochs;
  SELECT * INTO r FROM public.charter_creation_reservations WHERE clan_id=NEW.clan_id;
  SELECT * INTO p FROM public.charter_creation_terminal_posts WHERE reservation_id=r.id AND operation='activate';
  IF ep.id IS NULL OR r.id IS NULL OR p.ledger_id IS NULL OR p.tx_key IS DISTINCT FROM pg_current_xact_id()::text
   OR pg_trigger_depth()<>2 OR r.state<>'reserved' OR public.shardkeep_charter_terminal_money(p.ledger_id,true) IS NOT TRUE
   OR NEW.original_clan->>'id' IS DISTINCT FROM r.clan_id::text OR NEW.original_clan->>'leader_wallet' IS DISTINCT FROM r.payer
   OR NEW.original_clan->>'name' IS DISTINCT FROM r.name OR NEW.original_clan->>'tag' IS DISTINCT FROM r.tag
   OR EXISTS(SELECT 1 FROM public.clans WHERE id=NEW.clan_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.reservation_id:=r.id;NEW.epoch_id:=ep.id;NEW.post_id:=p.ledger_id;NEW.tx_key:=p.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_births' THEN
  SELECT * INTO t FROM public.charter_creation_terminals WHERE id=NEW.terminal_id;
  SELECT * INTO r FROM public.charter_creation_reservations WHERE id=t.reservation_id;
  SELECT * INTO ep FROM public.charter_sale_epochs;
  IF pg_trigger_depth()<>2 OR t.id IS NULL OR t.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR t.outcome<>'activated'
   OR r.id IS NULL OR ep.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.charter_sale_clan_inserts ci WHERE ci.clan_id=r.clan_id
    AND ci.reservation_id=r.id AND ci.epoch_id=ep.id AND ci.tx_key=t.tx_key AND ci.original_clan=t.clan_snapshot)
   OR NOT EXISTS(SELECT 1 FROM public.clans live WHERE id=r.clan_id AND to_jsonb(live)=t.clan_snapshot)
   OR NOT EXISTS(SELECT 1 FROM public.clan_members live WHERE player_wallet=r.payer AND to_jsonb(live)=t.founder_snapshot)
   OR jsonb_build_object('genesisHash',r.consent->'chain'->'genesisHash','economyProgram',r.consent->'chain'->'economyProgram',
    'craftProgram',r.consent->'chain'->'craftProgram') IS DISTINCT FROM ep.domain-'treasury'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.clan_id:=r.clan_id;NEW.reservation_id:=r.id;NEW.epoch_id:=ep.id;NEW.tx_key:=t.tx_key;NEW.original_terminal:=to_jsonb(t);
  NEW.born_at:=(t.clan_snapshot->>'created_at')::timestamptz;
  NEW.creation:=jsonb_build_object('creationIntentId',r.intent_id,'clanId',r.clan_id,'payer',r.payer,'metadata',r.consent->'metadata',
   'chain',r.consent->'chain','admissionCommitment',t.observation->'mint'->'admissionCommitment',
   'issuedPermitIds',jsonb_build_array(t.observation->'mint'->'permitId'));RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_heads' THEN
  SELECT * INTO b FROM public.charter_sale_births WHERE clan_id=NEW.clan_id;
  IF b.clan_id IS NULL OR b.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR pg_trigger_depth()<>2
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.leader_wallet:=b.creation->>'payer';NEW.revision:=0;NEW.last_sale_id:=NULL;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sales' THEN
  PERFORM public.shardkeep_charter_sale_owner();
  IF NEW.request IS NULL OR NEW.request IS DISTINCT FROM jsonb_build_object('clanId',NEW.request->'clanId','buyer',NEW.request->'buyer',
   'priceLamports',NEW.request->'priceLamports','sellerLeaves',NEW.request->'sellerLeaves','idempotencyKey',NEW.request->'idempotencyKey')
   OR NEW.request->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key OR length(NEW.idempotency_key) NOT BETWEEN 1 AND 128
   OR jsonb_typeof(NEW.request->'sellerLeaves') IS DISTINCT FROM 'boolean' OR NEW.request->>'priceLamports' !~ '^[1-9][0-9]*$'
   OR(NEW.request->>'priceLamports')::numeric>18446744073709551615
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INPUT';END IF;
  NEW.clan_id:=(NEW.request->>'clanId')::uuid;NEW.buyer:=NEW.request->>'buyer';
  SELECT * INTO c FROM public.clans WHERE id=NEW.clan_id FOR UPDATE NOWAIT;
  SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=NEW.clan_id FOR UPDATE NOWAIT;
  creation:=public.shardkeep_charter_sale_birth(NEW.clan_id);SELECT * INTO ep FROM public.charter_sale_epochs;
  IF c.id IS NULL OR h.clan_id IS NULL OR c.leader_wallet IS DISTINCT FROM NEW.seller OR h.leader_wallet IS DISTINCT FROM NEW.seller
   OR NEW.buyer=NEW.seller OR NEW.buyer IS NULL OR NOT EXISTS(SELECT 1 FROM public.players WHERE wallet=NEW.buyer)
   OR h.revision>=4294967295 OR NOT EXISTS(SELECT 1 FROM public.clan_members WHERE clan_id=c.id AND player_wallet=NEW.seller)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.id:=gen_random_uuid();NEW.created_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;
  terms:=jsonb_build_object('version',1,'id',NEW.id,'clanId',NEW.clan_id,'seller',NEW.seller,'buyer',NEW.buyer,
   'priceLamports',NEW.request->>'priceLamports','sellerLeaves',NEW.request->'sellerLeaves','domain',ep.domain,'expectedRevision',h.revision,
   'epochId',ep.id,'fenceId',gen_random_uuid(),'royaltyBps',ep.policy->'royaltyBps');
  NEW.original:=(terms-ARRAY['version','royaltyBps'])||jsonb_build_object('termsHash',encode(sha256(convert_to('SHARDKEEP_CHARTER_SALE_TERMS_V1'||terms::text,'UTF8')),'hex'),'creation',creation);
  RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_inventory_heads' THEN
  SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id;
  IF s.id IS NULL OR s.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR pg_trigger_depth()<>2
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.revision:=0;NEW.count:=0;NEW.tx_key:=s.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_fence_origins' THEN
  SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=NEW.fence_id;
  IF f.id IS NULL OR pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.original_fence:=to_jsonb(f);NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_acceptances' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id FOR UPDATE NOWAIT;
  SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=NEW.fence_id;
  SELECT * INTO origin FROM public.charter_sale_fence_origins WHERE fence_id=NEW.fence_id;
  IF s.id IS NULL OR origin.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR origin.original_fence IS DISTINCT FROM to_jsonb(f)
   OR f.clan_id IS DISTINCT FROM s.clan_id OR f.actor_wallet IS DISTINCT FROM s.seller OR f.idempotency_key IS DISTINCT FROM 'charter-sale:'||s.id::text
   OR NEW.terms_hash IS DISTINCT FROM s.original->>'termsHash' OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=s.id)
   OR EXISTS(SELECT 1 FROM public.charter_sale_acceptances prior JOIN public.charter_sales deal ON deal.id=prior.sale_id
    WHERE deal.buyer=s.buyer AND NOT EXISTS(SELECT 1 FROM public.charter_sale_terminals done WHERE done.sale_id=deal.id))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONFLICT';END IF;
  NEW.buyer_authority:=public.shardkeep_charter_member_payment_destination(s.buyer,NEW.buyer_base_id,NEW.freshness_ms);
  NEW.accepted_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_ante_posts' THEN
  SELECT * INTO ledger FROM public.ledger_transactions WHERE id=NEW.ledger_id;SELECT * INTO ep FROM public.charter_sale_epochs;
  IF pg_trigger_depth()<>2 OR ledger.id IS NULL OR ep.id IS NULL OR NOT((ledger.type='raid.ante' AND ledger.idempotency_key~'^raid-ante:raid:[0-9a-f]{64}:' AND length(ledger.idempotency_key)>80)
   OR(ledger.type='raid.ante.system_refund' AND ledger.idempotency_key~'^raid-ante-refund:[0-9a-f-]{36}$'))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  NEW.epoch_id:=ep.id;NEW.original_transaction:=to_jsonb(ledger);NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_ante_entries' THEN
  SELECT * INTO leg FROM public.ledger_entries WHERE id=NEW.entry_id;
  SELECT * INTO ante_post FROM public.charter_sale_ante_posts WHERE ledger_id=leg.txn_id;
  SELECT * INTO account FROM public.accounts WHERE id=leg.account_id;
  IF pg_trigger_depth()<>2 OR ante_post.ledger_id IS NULL OR ante_post.tx_key IS DISTINCT FROM pg_current_xact_id()::text
   OR leg.delta=0 OR account.currency<>'SHARDS' OR account.balance<0 OR leg.balance_after::numeric<>account.balance::numeric+leg.delta::numeric
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  NEW.ledger_id:=ante_post.ledger_id;NEW.original_entry:=to_jsonb(leg);NEW.account_identity:=to_jsonb(account)-'balance';
  NEW.before_balance:=account.balance;NEW.tx_key:=ante_post.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_ante_effects' THEN
  SELECT * INTO ante_entry FROM public.charter_sale_ante_entries WHERE entry_id=NEW.entry_id;
  SELECT * INTO account FROM public.accounts WHERE id=(ante_entry.original_entry->>'account_id')::uuid;
  IF pg_trigger_depth()<>2 OR ante_entry.entry_id IS NULL OR ante_entry.tx_key IS DISTINCT FROM pg_current_xact_id()::text
   OR NEW.after_account IS DISTINCT FROM to_jsonb(account) OR NEW.before_account-'balance' IS DISTINCT FROM ante_entry.account_identity
   OR NEW.after_account-'balance' IS DISTINCT FROM ante_entry.account_identity
   OR(NEW.before_account->>'balance')::bigint IS DISTINCT FROM ante_entry.before_balance
   OR(NEW.after_account->>'balance')::bigint IS DISTINCT FROM(ante_entry.original_entry->>'balance_after')::bigint
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  NEW.tx_key:=ante_entry.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_raid_admissions' THEN
  SELECT * INTO event FROM public.clan_charter_raid_events WHERE raid_id=NEW.raid_id;
  SELECT * INTO raid FROM public.raids WHERE id=NEW.raid_id;SELECT * INTO ep FROM public.charter_sale_epochs;
  -- raids AFTER INSERT -> event AFTER INSERT -> this private admission.
  IF pg_trigger_depth()<>3 OR event.raid_id IS NULL OR event.source_id IS DISTINCT FROM ep.source_id
   OR event.chest_admission_tx IS DISTINCT FROM pg_current_xact_id()::text OR raid.status<>'pending_orders'
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  IF raid.attacker_base_id IS NULL THEN SELECT keep_level INTO NEW.keep_level FROM public.players WHERE wallet=raid.attacker_wallet;
  ELSE SELECT keep_level INTO NEW.keep_level FROM public.bases WHERE id=raid.attacker_base_id;END IF;
  NEW.epoch_id:=ep.id;NEW.event:=to_jsonb(event);NEW.original_raid:=to_jsonb(raid);NEW.tx_key:=event.chest_admission_tx;
  NEW.ante_amount:=CASE WHEN event.kind IN('pve','campaign') THEN 0 ELSE
   (ep.policy->'anteSchedule'->>least(greatest(NEW.keep_level,1)-1,jsonb_array_length(ep.policy->'anteSchedule')-1))::bigint END;
  SELECT * INTO ante_post FROM public.charter_sale_ante_posts WHERE original_transaction->>'idempotency_key'='raid-ante:'||raid.idempotency_key;
  IF NEW.ante_amount>0 THEN
   -- createRaid persists raid:<sha256(wallet NUL pvp)>:<opaque client key>.
   -- The prospective epoch never adopts a pre-namespaced legacy charge.
   IF ante_post.ledger_id IS NULL OR ante_post.tx_key IS DISTINCT FROM NEW.tx_key
    OR left(raid.idempotency_key,70) IS DISTINCT FROM 'raid:'||encode(sha256(convert_to(raid.attacker_wallet,'UTF8')||decode('00','hex')||convert_to('pvp','UTF8')),'hex')||':'
    OR length(raid.idempotency_key)<=70 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
   expected_metadata:=jsonb_build_object('keepLevel',NEW.keep_level,'defender',raid.defender_wallet);
   IF raid.attacker_base_id IS NULL THEN expected_metadata:=expected_metadata||jsonb_build_object('wallet',raid.attacker_wallet);
   ELSE expected_metadata:=expected_metadata||jsonb_build_object('baseId',raid.attacker_base_id,'attackerBaseId',raid.attacker_base_id);END IF;
   IF raid.defender_base_id IS NOT NULL THEN expected_metadata:=expected_metadata||jsonb_build_object('defenderBaseId',raid.defender_base_id);END IF;
   IF ante_post.original_transaction->'metadata' IS DISTINCT FROM expected_metadata THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
   NEW.ante_post:=ante_post.ledger_id;
  ELSE
   IF ante_post.ledger_id IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;NEW.ante_post:=NULL;
  END IF;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_raid_outcomes' THEN
  SELECT * INTO raid FROM public.raids WHERE id=NEW.raid_id;
  IF pg_trigger_depth()<>2 OR to_jsonb(raid) IS DISTINCT FROM NEW.after_raid OR raid.status NOT IN('expired','resolved')
   OR NEW.before_raid->>'id' IS DISTINCT FROM raid.id::text OR NEW.before_raid->>'status' NOT IN('pending_orders','resolving')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
  SELECT to_jsonb(live) INTO NEW.live_state FROM public.raid_live_states live WHERE live.raid_id=raid.id;
  NEW.observed_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_attempts' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id FOR UPDATE NOWAIT;
  SELECT * INTO acceptance FROM public.charter_sale_acceptances WHERE sale_id=s.id;
  SELECT * INTO inventory_head FROM public.charter_sale_inventory_heads WHERE sale_id=s.id FOR UPDATE NOWAIT;
  SELECT * INTO ep FROM public.charter_sale_epochs;
  quote:=NEW.record->'quote';
  IF s.id IS NULL OR acceptance.sale_id IS NULL OR inventory_head.sale_id IS NULL OR inventory_head.revision<>0
   OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=s.id)
   OR quote->'packetInput'->'original' IS DISTINCT FROM public.shardkeep_charter_sale_chain_original(s.id)
   OR quote->>'version' IS DISTINCT FROM '1' OR quote->>'signingAuthorized' IS DISTINCT FROM 'false'
   OR quote->>'transferAuthorized' IS DISTINCT FROM 'false' OR quote->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
   OR quote->'observation'->>'registryRevision' IS DISTINCT FROM s.original->>'expectedRevision'
   OR quote->'observation'->>'registryLeader' IS DISTINCT FROM s.seller OR quote->'observation'->>'lockKind' IS DISTINCT FROM '0'
   OR quote->'observation'->>'admissionPaused' IS DISTINCT FROM 'false' OR quote->'observation'->>'craftPaused' IS DISTINCT FROM 'false'
   OR quote->'packetInput'->>'policySigner' IS DISTINCT FROM quote->'observation'->>'policySigner'
   OR public.shardkeep_charter_sale_pins(s.id,quote->'observation'->'source') IS NOT TRUE
   OR NEW.record->>'elapsedMs' IS NULL OR(NEW.record->>'elapsedMs')::double precision<0
   OR(NEW.record->>'elapsedMs')::double precision>(ep.policy->>'observationMaxAgeMs')::double precision
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  PERFORM public.shardkeep_charter_sale_expiry(quote->'packetInput'->>'candidateHex');
  NEW.source:=jsonb_build_object('clearance',public.shardkeep_charter_sale_clearance(s.id),'elapsedMs',NEW.record->'elapsedMs');
  NEW.buyer_authority:=public.shardkeep_charter_member_payment_destination(s.buyer,acceptance.buyer_base_id,NEW.freshness_ms);
  NEW.id:=gen_random_uuid();NEW.record:=jsonb_build_object('id',NEW.id,'candidateHex',quote->'packetInput'->'candidateHex',
   'policySigner',quote->'packetInput'->'policySigner','quote',quote);NEW.recorded_at:=clock_timestamp();NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_preparations' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO attempt FROM public.charter_sale_attempts WHERE sale_id=NEW.sale_id;
  IF attempt.id IS NULL OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=NEW.sale_id)
   OR NEW.record IS DISTINCT FROM jsonb_build_object('policySignatureHex',NEW.record->'policySignatureHex','packet',NEW.record->'packet')
   OR coalesce(NEW.record->>'policySignatureHex','') !~ '^[0-9a-f]{128}$' OR NEW.record->'packet'->>'signingAuthorized' IS DISTINCT FROM 'false'
   OR NEW.record->'packet'->>'relayAuthorized' IS DISTINCT FROM 'false' OR NEW.record->'packet'->>'version' IS DISTINCT FROM '1'
   OR NEW.record->'packet'->>'messageSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->'packet'->>'messageHex','hex')),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_wires' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO preparation FROM public.charter_sale_preparations WHERE sale_id=NEW.sale_id;
  IF preparation.sale_id IS NULL OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=NEW.sale_id)
   OR NEW.record IS DISTINCT FROM jsonb_build_object('signedTransactionHex',NEW.record->'signedTransactionHex','signature',NEW.record->'signature',
    'wireSha256',NEW.record->'wireSha256','messageSha256',NEW.record->'messageSha256')
   OR NEW.record->>'messageSha256' IS DISTINCT FROM preparation.record->'packet'->>'messageSha256'
   OR NEW.record->>'wireSha256' IS DISTINCT FROM encode(sha256(decode(NEW.record->>'signedTransactionHex','hex')),'hex')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.tx_key:=pg_current_xact_id()::text;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_terminals' THEN
  PERFORM public.shardkeep_charter_sale_owner();SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id FOR UPDATE NOWAIT;
  SELECT * INTO acceptance FROM public.charter_sale_acceptances WHERE sale_id=s.id;
  SELECT * INTO inventory_head FROM public.charter_sale_inventory_heads WHERE sale_id=s.id FOR UPDATE NOWAIT;
  SELECT * INTO attempt FROM public.charter_sale_attempts WHERE sale_id=s.id;
  SELECT * INTO wire FROM public.charter_sale_wires WHERE sale_id=s.id;
  SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=s.clan_id FOR UPDATE NOWAIT;
  SELECT * INTO c FROM public.clans WHERE id=s.clan_id FOR UPDATE NOWAIT;SELECT * INTO ep FROM public.charter_sale_epochs;
  IF s.id IS NULL OR inventory_head.sale_id IS NULL OR inventory_head.count<>(CASE WHEN attempt.id IS NULL THEN 0 ELSE 1 END)
   OR h.revision IS DISTINCT FROM(s.original->>'expectedRevision')::bigint OR h.leader_wallet IS DISTINCT FROM s.seller
   OR c.leader_wallet IS DISTINCT FROM s.seller THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.inventory:=jsonb_build_object('version',1,'revision',inventory_head.revision::text,'count',inventory_head.count,
   'messages',CASE WHEN attempt.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(attempt.record->'candidateHex') END);
  NEW.clan_before:=to_jsonb(c);NEW.clan_after:=to_jsonb(c);
  SELECT coalesce(jsonb_agg(to_jsonb(member) ORDER BY member.player_wallet COLLATE "C"),'[]'::jsonb) INTO NEW.roster_before FROM public.clan_members member WHERE clan_id=s.clan_id;
  NEW.roster_after:=NEW.roster_before;
  IF NEW.outcome='completed' THEN
   NEW.source:=public.shardkeep_charter_sale_clearance(s.id);receipt:=NEW.record->'receipt';
   royalty:=floor((s.original->>'priceLamports')::numeric*(ep.policy->>'royaltyBps')::numeric/(ep.policy->>'basisPoints')::numeric);
   expected_receipt:=jsonb_build_object('transferId',s.id,'fenceId',s.original->'fenceId','clanId',s.clan_id,'seller',s.seller,'buyer',s.buyer,
    'treasury',s.original->'domain'->'treasury','priceLamports',s.original->>'priceLamports','sellerLamports',((s.original->>'priceLamports')::numeric-royalty)::text,
    'royaltyLamports',royalty::text,'priorRevision',h.revision,'revision',h.revision+1,'termsHash',s.original->'termsHash','acceptedAt',receipt->'acceptedAt');
   IF wire.sale_id IS NULL OR receipt IS DISTINCT FROM expected_receipt OR coalesce(receipt->>'acceptedAt','') !~ '^(0|[1-9][0-9]*)$'
    OR NEW.record->>'version' IS DISTINCT FROM '1' OR NEW.record->>'signature' IS DISTINCT FROM wire.record->>'signature'
    OR NEW.record->>'wireSha256' IS DISTINCT FROM wire.record->>'wireSha256' OR NEW.record->>'messageSha256' IS DISTINCT FROM wire.record->>'messageSha256'
    OR NEW.record->>'finalizedTransferObserved' IS DISTINCT FROM 'true' OR NEW.record->>'backendClearanceVerified' IS DISTINCT FROM 'false'
    OR NEW.record->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
   NEW.clan_after:=jsonb_set(jsonb_set(NEW.clan_before,'{leader_wallet}',to_jsonb(s.buyer)),'{invite_code}',CASE WHEN c.invite_mode='invite' THEN to_jsonb(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')) ELSE 'null'::jsonb END);
   SELECT coalesce(jsonb_agg(member ORDER BY member->>'player_wallet' COLLATE "C"),'[]'::jsonb)
   INTO NEW.roster_after FROM jsonb_array_elements(NEW.roster_before) member
    WHERE NOT((s.original->>'sellerLeaves')::boolean AND member->>'player_wallet'=s.seller);
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.roster_after) member WHERE member->>'player_wallet'=s.buyer) THEN
    NEW.roster_after:=NEW.roster_after||jsonb_build_array(jsonb_build_object('player_wallet',s.buyer,'clan_id',s.clan_id,'joined_at',clock_timestamp()));
   END IF;
   SELECT jsonb_agg(member ORDER BY member->>'player_wallet' COLLATE "C") INTO NEW.roster_after FROM jsonb_array_elements(NEW.roster_after) member;
   IF jsonb_array_length(NEW.roster_after)>(ep.policy->>'rosterCap')::integer THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONFLICT';END IF;
  ELSIF NEW.outcome='cancelled' THEN
   IF NEW.record->'original' IS DISTINCT FROM public.shardkeep_charter_sale_chain_original(s.id)
    OR NEW.record->'inventory' IS DISTINCT FROM NEW.inventory OR NEW.record->>'outcome' IS DISTINCT FROM 'absent-after-expiry'
    OR NEW.record->'receipt' IS DISTINCT FROM 'null'::jsonb OR NEW.record->>'fenceReleaseAuthorized' IS DISTINCT FROM 'false'
    OR NEW.record->>'transferAuthorized' IS DISTINCT FROM 'false' OR public.shardkeep_charter_sale_pins(s.id,NEW.record->'source') IS NOT TRUE
    OR coalesce(NEW.record->>'unixTimestamp','') !~ '^[1-9][0-9]*$'
    OR(attempt.id IS NOT NULL AND(NEW.record->>'unixTimestamp')::numeric<=public.shardkeep_charter_sale_expiry(attempt.record->>'candidateHex'))
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
   NEW.source:=jsonb_build_object('head',to_jsonb(h));
  ELSE RAISE EXCEPTION 'CLAN_CHARTER_SALE_STATE';END IF;
  NEW.id:=gen_random_uuid();NEW.tx_key:=pg_current_xact_id()::text;NEW.completed_at:=clock_timestamp();RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_fence_releases' THEN
  SELECT * INTO terminal FROM public.charter_sale_terminals WHERE sale_id=NEW.sale_id;
  SELECT * INTO acceptance FROM public.charter_sale_acceptances WHERE sale_id=NEW.sale_id;
  SELECT * INTO payment FROM public.clan_charter_member_payments WHERE fence_id=acceptance.fence_id;
  IF terminal.sale_id IS NULL OR terminal.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR pg_trigger_depth()<>2
   OR acceptance.fence_id IS DISTINCT FROM NEW.fence_id THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.terminal_id:=terminal.id;NEW.payment_source:=payment.source;NEW.tx_key:=terminal.tx_key;RETURN NEW;
 ELSIF TG_TABLE_NAME='charter_sale_effects' THEN
  SELECT * INTO terminal FROM public.charter_sale_terminals WHERE sale_id=NEW.sale_id;
  IF terminal.sale_id IS NULL OR terminal.tx_key IS DISTINCT FROM pg_current_xact_id()::text
   OR public.shardkeep_charter_sale_projection(NEW.kind,NEW.before_row,NEW.after_row) IS NOT TRUE
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  IF NEW.kind='clans' THEN SELECT to_jsonb(live) INTO actual FROM public.clans live WHERE id=NEW.target::uuid;
  ELSIF NEW.kind='clan_members' THEN SELECT to_jsonb(live) INTO actual FROM public.clan_members live WHERE player_wallet=NEW.target;
  ELSIF NEW.kind='charter_sale_heads' THEN SELECT to_jsonb(live) INTO actual FROM public.charter_sale_heads live WHERE clan_id=NEW.target::uuid;
  ELSE RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  IF actual IS DISTINCT FROM NEW.after_row THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  NEW.tx_key:=terminal.tx_key;RETURN NEW;
 END IF;
 RAISE EXCEPTION 'CLAN_CHARTER_SALE_STATE';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r public.charter_creation_reservations%ROWTYPE;b public.charter_sale_births%ROWTYPE;s public.charter_sales%ROWTYPE;member jsonb;
BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_TABLE_NAME NOT IN('charter_creation_terminals','charter_sales','clan_charter_member_fences','charter_sale_attempts','charter_sale_terminals')
 OR TG_NAME<>TG_TABLE_NAME||'_charter_sale_capture' OR TG_WHEN<>'AFTER' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_sale_hooks();
 IF TG_TABLE_NAME='charter_creation_terminals' THEN
  IF NEW.outcome='activated' AND EXISTS(SELECT 1 FROM public.charter_sale_epochs) THEN
   SELECT * INTO r FROM public.charter_creation_reservations WHERE id=NEW.reservation_id;
   -- A terminal can seal only the witness captured before the actual clan
   -- insert. An epoch introduced between clan and terminal cannot backfill it.
   IF EXISTS(SELECT 1 FROM public.charter_sale_clan_inserts WHERE clan_id=r.clan_id) THEN
    INSERT INTO public.charter_sale_births(terminal_id) VALUES(NEW.id) RETURNING * INTO b;
    INSERT INTO public.charter_sale_heads(clan_id) VALUES(b.clan_id);
    INSERT INTO public.clan_charter_raid_chest_heads(clan_id) VALUES(b.clan_id);
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='charter_sales' THEN
  INSERT INTO public.charter_sale_inventory_heads(sale_id) VALUES(NEW.id);
 ELSIF TG_TABLE_NAME='charter_sale_attempts' THEN
  UPDATE public.charter_sale_inventory_heads SET revision=1,count=1,tx_key=NEW.tx_key WHERE sale_id=NEW.sale_id;
 ELSIF TG_TABLE_NAME='charter_sale_terminals' THEN
  SELECT * INTO s FROM public.charter_sales WHERE id=NEW.sale_id;
  IF NEW.outcome='completed' THEN
   UPDATE public.clans SET leader_wallet=s.buyer,invite_code=NEW.clan_after->>'invite_code' WHERE id=s.clan_id;
   DELETE FROM public.clan_members live WHERE live.clan_id=s.clan_id
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.roster_after) retained_member WHERE retained_member->>'player_wallet'=live.player_wallet);
   FOR member IN SELECT incoming.new_value FROM jsonb_array_elements(NEW.roster_after) incoming(new_value) WHERE NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(NEW.roster_before) existing(old_value)
     WHERE existing.old_value->>'player_wallet'=incoming.new_value->>'player_wallet') LOOP
    INSERT INTO public.clan_members(player_wallet,clan_id,joined_at) VALUES(member->>'player_wallet',(member->>'clan_id')::uuid,(member->>'joined_at')::timestamptz);
   END LOOP;
   UPDATE public.charter_sale_heads SET leader_wallet=s.buyer,revision=revision+1,last_sale_id=s.id WHERE clan_id=s.clan_id;
  END IF;
  INSERT INTO public.charter_sale_fence_releases(fence_id,sale_id) SELECT fence_id,s.id FROM public.charter_sale_acceptances WHERE sale_id=s.id;
 ELSIF TG_TABLE_NAME='clan_charter_member_fences' THEN
  IF NEW.idempotency_key LIKE 'charter-sale:%' THEN INSERT INTO public.charter_sale_fence_origins(fence_id) VALUES(NEW.id);END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE owner_id oid;ids text[];cid uuid;v record;
BEGIN
 SELECT relowner INTO owner_id FROM pg_class WHERE oid='public.charter_sales'::regclass;
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_TABLE_NAME NOT IN('clans','clan_members','ledger_transactions','ledger_entries','accounts','raids')
 OR TG_NAME<>(TG_TABLE_NAME||(CASE WHEN TG_OP='TRUNCATE' THEN '_charter_sale_no_truncate' ELSE '_charter_sale_source' END))
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid
  WHERE t.tgrelid=TG_RELID AND t.tgname=TG_NAME AND t.tgfoid='public.shardkeep_charter_sale_source()'::regprocedure
  AND t.tgtype=(CASE WHEN TG_OP='TRUNCATE' THEN 34 ELSE 31 END) AND t.tgenabled='O' AND t.tgqual IS NULL AND t.tgnargs=0
  AND t.tgattr=''::int2vector AND p.prosecdef AND p.proowner=owner_id AND c.relowner=owner_id)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_TRIGGER';END IF;
 -- RC-first includes dormant epochs: a writer's old snapshot cannot hide a
 -- source installed after that snapshot. No runtime private grants are needed.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_READ_COMMITTED';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.charter_sale_epochs) THEN
  IF TG_OP='TRUNCATE' THEN RETURN NULL;ELSIF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END IF;
 PERFORM public.shardkeep_charter_sale_hooks();
 IF TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';
 END IF;
 IF TG_TABLE_NAME='clans' THEN
  IF TG_OP='INSERT' THEN
   IF EXISTS(SELECT 1 FROM public.charter_creation_terminal_posts p JOIN public.charter_creation_reservations r ON r.id=p.reservation_id
    WHERE r.clan_id=NEW.id AND p.operation='activate' AND p.tx_key=pg_current_xact_id()::text) THEN
    INSERT INTO public.charter_sale_clan_inserts(clan_id,original_clan) VALUES(NEW.id,to_jsonb(NEW));
   END IF;
  ELSIF EXISTS(SELECT 1 FROM public.charter_sale_births WHERE clan_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
   IF public.shardkeep_charter_sale_projection('clans',to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW;END IF;
   IF(NEW.id,NEW.name,NEW.tag,NEW.created_at,NEW.leader_wallet) IS DISTINCT FROM(OLD.id,OLD.name,OLD.tag,OLD.created_at,OLD.leader_wallet)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='clan_members' THEN
  IF public.shardkeep_charter_sale_projection('clan_members',CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
  IF TG_OP='INSERT' THEN ids:=ARRAY[NEW.player_wallet];ELSIF TG_OP='DELETE' THEN ids:=ARRAY[OLD.player_wallet];ELSE ids:=ARRAY[OLD.player_wallet,NEW.player_wallet];END IF;
  IF EXISTS(SELECT 1 FROM public.charter_sales s JOIN public.charter_sale_acceptances a ON a.sale_id=s.id
   WHERE s.buyer=ANY(ids) AND NOT EXISTS(SELECT 1 FROM public.charter_sale_terminals t WHERE t.sale_id=s.id))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_BUYER_RESERVED';END IF;
 ELSIF TG_TABLE_NAME='ledger_transactions' THEN
  IF TG_OP<>'INSERT' THEN
   IF EXISTS(SELECT 1 FROM public.charter_sale_ante_posts saved WHERE saved.ledger_id=OLD.id OR(TG_OP='UPDATE' AND saved.ledger_id=NEW.id))
    OR OLD.type IN('raid.ante','raid.ante.system_refund') OR OLD.idempotency_key LIKE 'raid-ante:%' OR OLD.idempotency_key LIKE 'raid-ante-refund:%'
    OR(TG_OP='UPDATE' AND(NEW.type IN('raid.ante','raid.ante.system_refund') OR NEW.idempotency_key LIKE 'raid-ante:%' OR NEW.idempotency_key LIKE 'raid-ante-refund:%'))
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='ledger_entries' THEN
  IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.charter_sale_ante_posts saved WHERE saved.ledger_id=OLD.txn_id OR(TG_OP='UPDATE' AND saved.ledger_id=NEW.txn_id))
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';END IF;
 ELSIF TG_TABLE_NAME='accounts' THEN
  IF TG_OP<>'INSERT' THEN
   IF EXISTS(SELECT 1 FROM public.charter_sale_ante_entries saved WHERE saved.original_entry->>'account_id'=OLD.id::text)
    AND(TG_OP='DELETE' OR to_jsonb(OLD)-'balance' IS DISTINCT FROM to_jsonb(NEW)-'balance')
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_IMMUTABLE';END IF;
   IF TG_OP='UPDATE' THEN
    IF EXISTS(SELECT 1 FROM public.charter_sale_ante_entries saved WHERE saved.tx_key=pg_current_xact_id()::text AND saved.original_entry->>'account_id'=OLD.id::text
     AND NOT EXISTS(SELECT 1 FROM public.charter_sale_ante_effects effect WHERE effect.entry_id=saved.entry_id)
     AND(saved.before_balance IS DISTINCT FROM OLD.balance OR(saved.original_entry->>'balance_after')::bigint IS DISTINCT FROM NEW.balance))
    THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_ANTE_SOURCE';END IF;
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b public.charter_sale_births%ROWTYPE;s public.charter_sales%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;h public.charter_sale_inventory_heads%ROWTYPE;x record;
BEGIN
 IF TG_RELID<>to_regclass('public.'||TG_TABLE_NAME) OR TG_NAME<>TG_TABLE_NAME||'_charter_sale_complete'
 OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_TRIGGER';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.charter_sale_epochs) THEN RETURN NULL;END IF;
 PERFORM public.shardkeep_charter_sale_hooks();
 FOR b IN SELECT * FROM public.charter_sale_births WHERE tx_key=pg_current_xact_id()::text LOOP
  PERFORM public.shardkeep_charter_sale_birth(b.clan_id);
  IF NOT EXISTS(SELECT 1 FROM public.charter_sale_heads WHERE clan_id=b.clan_id AND revision=0 AND leader_wallet=b.creation->>'payer')
   OR NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_chest_heads WHERE clan_id=b.clan_id AND first_raid_id IS NULL)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.charter_sale_clan_inserts ci WHERE ci.tx_key=pg_current_xact_id()::text
  AND NOT EXISTS(SELECT 1 FROM public.charter_sale_births born WHERE born.clan_id=ci.clan_id AND born.epoch_id=ci.epoch_id AND born.tx_key=ci.tx_key))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 FOR s IN SELECT * FROM public.charter_sales WHERE tx_key=pg_current_xact_id()::text LOOP
  SELECT * INTO h FROM public.charter_sale_inventory_heads WHERE sale_id=s.id;
  IF h.sale_id IS NULL OR h.revision<>(SELECT count(*) FROM public.charter_sale_attempts WHERE sale_id=s.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.charter_sale_fence_origins f WHERE f.tx_key=pg_current_xact_id()::text
  AND NOT EXISTS(SELECT 1 FROM public.charter_sale_acceptances accepted WHERE accepted.fence_id=f.fence_id AND accepted.tx_key=f.tx_key))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 FOR a IN SELECT * FROM public.charter_sale_acceptances WHERE tx_key=pg_current_xact_id()::text LOOP
  SELECT * INTO s FROM public.charter_sales WHERE id=a.sale_id;
  IF a.buyer_authority IS DISTINCT FROM public.shardkeep_charter_member_payment_destination(s.buyer,a.buyer_base_id,a.freshness_ms)
   OR EXISTS(SELECT 1 FROM public.clan_members WHERE player_wallet=s.buyer AND clan_id<>s.clan_id)
   OR NOT EXISTS(SELECT 1 FROM public.charter_sale_fence_origins f WHERE f.fence_id=a.fence_id AND f.tx_key=a.tx_key)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 FOR x IN SELECT * FROM public.charter_sale_attempts WHERE tx_key=pg_current_xact_id()::text LOOP
  SELECT * INTO s FROM public.charter_sales WHERE id=x.sale_id;SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=x.sale_id;
  SELECT * INTO h FROM public.charter_sale_inventory_heads WHERE sale_id=x.sale_id;
  IF h.revision IS DISTINCT FROM 1 OR h.count IS DISTINCT FROM 1 OR h.tx_key IS DISTINCT FROM x.tx_key
   OR x.buyer_authority IS DISTINCT FROM public.shardkeep_charter_member_payment_destination(s.buyer,a.buyer_base_id,x.freshness_ms)
   OR x.source->'clearance' IS DISTINCT FROM public.shardkeep_charter_sale_clearance(s.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 FOR x IN SELECT * FROM public.charter_sale_inventory_heads WHERE tx_key=pg_current_xact_id()::text LOOP
  IF x.count<>(SELECT count(*) FROM public.charter_sale_attempts WHERE sale_id=x.sale_id) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
 END LOOP;
 FOR x IN SELECT * FROM public.charter_sale_ante_posts WHERE tx_key=pg_current_xact_id()::text LOOP
  PERFORM public.shardkeep_charter_sale_ante_post(x.ledger_id);
  IF x.original_transaction->>'type'='raid.ante' THEN
   IF NOT EXISTS(SELECT 1 FROM public.charter_sale_raid_admissions admission WHERE admission.ante_post=x.ledger_id AND admission.tx_key=x.tx_key)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM public.charter_sale_raid_outcomes outcome WHERE outcome.raid_id::text=x.original_transaction->'metadata'->>'raidId'
    AND outcome.tx_key=x.tx_key AND outcome.after_raid->>'status'='expired') THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_INCOMPLETE';END IF;
  END IF;
 END LOOP;
 FOR x IN SELECT raid_id FROM public.charter_sale_raid_admissions WHERE tx_key=pg_current_xact_id()::text LOOP
  PERFORM public.shardkeep_charter_sale_ante_proof(x.raid_id,false);
 END LOOP;
 FOR x IN SELECT sale_id FROM public.charter_sale_terminals WHERE tx_key=pg_current_xact_id()::text LOOP
  PERFORM public.shardkeep_charter_sale_terminal_history(x.sale_id,true);
 END LOOP;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_epoch(domain_value jsonb,policy_value jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.charter_sale_epochs%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_sale_owner();PERFORM public.shardkeep_charter_sale_hooks();
 LOCK TABLE public.charter_sale_epochs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
 SELECT * INTO e FROM public.charter_sale_epochs;
 IF e.id IS NULL THEN
  PERFORM public.shardkeep_clan_charter_raid_chest_rule_initialize((policy_value->>'titheBps')::integer,(policy_value->>'basisPoints')::integer);
  INSERT INTO public.charter_sale_epochs(domain,policy) VALUES(domain_value,policy_value) RETURNING * INTO e;
 ELSIF e.domain IS DISTINCT FROM domain_value OR e.policy IS DISTINCT FROM policy_value THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONFLICT';END IF;
 RETURN jsonb_build_object('version',1,'id',e.id,'domain',e.domain);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_read(actor text,sid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;h public.charter_sale_inventory_heads%ROWTYPE;
 p public.charter_sale_attempts%ROWTYPE;prep public.charter_sale_preparations%ROWTYPE;wire public.charter_sale_wires%ROWTYPE;
 terminal public.charter_sale_terminals%ROWTYPE;payment jsonb;state text;
BEGIN
 PERFORM public.shardkeep_charter_sale_owner();PERFORM public.shardkeep_charter_sale_hooks();
 SELECT * INTO s FROM public.charter_sales WHERE id=sid;
 IF s.id IS NULL OR actor NOT IN(s.seller,s.buyer) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_NOT_FOUND';END IF;
 PERFORM public.shardkeep_charter_sale_birth(s.clan_id);
 SELECT * INTO h FROM public.charter_sale_inventory_heads WHERE sale_id=sid;
 SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=sid;
 SELECT * INTO p FROM public.charter_sale_attempts WHERE sale_id=sid;
 SELECT * INTO prep FROM public.charter_sale_preparations WHERE sale_id=sid;
 SELECT * INTO wire FROM public.charter_sale_wires WHERE sale_id=sid;
 SELECT * INTO terminal FROM public.charter_sale_terminals WHERE sale_id=sid;
 IF h.sale_id IS NULL OR h.count<>(CASE WHEN p.id IS NULL THEN 0 ELSE 1 END) THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 IF terminal.sale_id IS NOT NULL THEN PERFORM public.shardkeep_charter_sale_terminal_history(sid,false);END IF;
 IF a.sale_id IS NOT NULL THEN payment:=public.shardkeep_charter_member_payment_read(a.fence_id,s.seller);END IF;
 state:=CASE WHEN terminal.sale_id IS NOT NULL THEN terminal.outcome WHEN wire.sale_id IS NOT NULL THEN 'signed'
  WHEN prep.sale_id IS NOT NULL THEN 'prepared' WHEN p.id IS NOT NULL THEN 'issuing' WHEN payment IS NOT NULL THEN 'members_paid'
  WHEN a.sale_id IS NOT NULL THEN 'accepted' ELSE 'draft' END;
 RETURN jsonb_build_object('version',1,'original',s.original,'status',state,'fenceId',s.original->'fenceId',
  'acceptance',CASE WHEN a.sale_id IS NULL THEN NULL ELSE jsonb_build_object('termsHash',a.terms_hash,'buyerBaseId',a.buyer_base_id,
   'acceptedAt',to_char(a.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) END,
  'memberPayment',CASE WHEN payment IS NULL THEN NULL ELSE jsonb_build_object('id',payment->'id','totalShards',payment->'totalShards') END,
  'attempt',CASE WHEN p.id IS NULL THEN NULL ELSE p.record END,'preparation',prep.record,'signed',wire.record,
  'terminal',CASE WHEN terminal.sale_id IS NULL THEN NULL ELSE jsonb_build_object('id',terminal.id,'outcome',terminal.outcome,'record',terminal.record) END,
  'inventory',jsonb_build_object('version',1,'revision',h.revision::text,'count',h.count,
   'messages',CASE WHEN p.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p.record->'candidateHex') END));
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_draft(actor text,request_value jsonb,domain_value jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;e public.charter_sale_epochs%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_sale_owner();PERFORM public.shardkeep_charter_sale_hooks();
 SELECT * INTO s FROM public.charter_sales WHERE seller=actor AND idempotency_key=request_value->>'idempotencyKey';
 IF s.id IS NOT NULL THEN
  IF s.request IS DISTINCT FROM request_value THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONFLICT';END IF;
  RETURN public.shardkeep_charter_sale_read(actor,s.id);
 END IF;
 SELECT * INTO e FROM public.charter_sale_epochs;
 IF domain_value IS NULL OR e.id IS NULL OR e.domain IS DISTINCT FROM domain_value THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
 INSERT INTO public.charter_sales(seller,idempotency_key,request) VALUES(actor,request_value->>'idempotencyKey',request_value) RETURNING * INTO s;
 RETURN public.shardkeep_charter_sale_read(actor,s.id);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_sale_accept(actor text,sid uuid,request_value jsonb,freshness integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE s public.charter_sales%ROWTYPE;a public.charter_sale_acceptances%ROWTYPE;f public.clan_charter_member_fences%ROWTYPE;
 c public.clans%ROWTYPE;h public.charter_sale_heads%ROWTYPE;ep public.charter_sale_epochs%ROWTYPE;bid uuid;
BEGIN
 PERFORM public.shardkeep_charter_sale_owner();PERFORM public.shardkeep_charter_sale_hooks();
 SELECT * INTO s FROM public.charter_sales WHERE id=sid;
 IF s.id IS NULL OR s.buyer IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_NOT_FOUND';END IF;
 SELECT * INTO a FROM public.charter_sale_acceptances WHERE sale_id=sid;
 IF a.sale_id IS NOT NULL THEN
  IF request_value IS DISTINCT FROM jsonb_build_object('termsHash',a.terms_hash,'buyerBaseId',a.buyer_base_id)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONFLICT';END IF;RETURN public.shardkeep_charter_sale_read(actor,sid);
 END IF;
 IF request_value IS DISTINCT FROM jsonb_build_object('termsHash',request_value->'termsHash','buyerBaseId',request_value->'buyerBaseId')
  OR request_value->>'termsHash' IS DISTINCT FROM s.original->>'termsHash' THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONFLICT';END IF;
 bid:=(request_value->>'buyerBaseId')::uuid;
 PERFORM 1 FROM public.players WHERE wallet IN(s.seller,s.buyer) ORDER BY wallet COLLATE "C" FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.bases WHERE id=bid FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.base_slots WHERE base_id=bid ORDER BY wallet,slot FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.deed_ownership_observations WHERE base_id=bid FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.base_raid_locks WHERE base_id=bid FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.raids WHERE attacker_base_id=bid AND status IN('pending_orders','resolving') ORDER BY id FOR UPDATE NOWAIT;
 PERFORM 1 FROM public.charter_creation_reservations WHERE clan_id=s.clan_id FOR UPDATE NOWAIT;
 SELECT * INTO s FROM public.charter_sales WHERE id=sid FOR UPDATE NOWAIT;
 LOCK TABLE public.clans,public.clan_members,public.base_slots,public.bases,public.deed_ownership_observations,public.base_raid_locks,public.raids IN SHARE MODE NOWAIT;
 SELECT * INTO c FROM public.clans WHERE id=s.clan_id FOR UPDATE NOWAIT;
 SELECT * INTO h FROM public.charter_sale_heads WHERE clan_id=s.clan_id FOR UPDATE NOWAIT;
 SELECT * INTO ep FROM public.charter_sale_epochs;
 IF c.id IS NULL OR c.leader_wallet IS DISTINCT FROM s.seller OR h.leader_wallet IS DISTINCT FROM s.seller
  OR h.revision IS DISTINCT FROM(s.original->>'expectedRevision')::bigint OR EXISTS(SELECT 1 FROM public.charter_sale_terminals WHERE sale_id=sid)
  OR EXISTS(SELECT 1 FROM public.clan_members WHERE player_wallet=s.buyer AND clan_id<>s.clan_id)
  OR(EXISTS(SELECT 1 FROM public.clan_members WHERE player_wallet=s.buyer AND clan_id=s.clan_id) IS FALSE
   AND(SELECT count(*) FROM public.clan_members WHERE clan_id=s.clan_id)>=(ep.policy->>'rosterCap')::integer AND NOT(s.request->>'sellerLeaves')::boolean)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_CONFLICT';END IF;
 PERFORM public.shardkeep_charter_member_payment_destination(s.buyer,bid,freshness);
 INSERT INTO public.clan_charter_member_fences(id,clan_id,actor_wallet,idempotency_key)
 VALUES((s.original->>'fenceId')::uuid,s.clan_id,s.seller,'charter-sale:'||s.id::text) RETURNING * INTO f;
 INSERT INTO public.charter_sale_acceptances(sale_id,fence_id,terms_hash,buyer_base_id,freshness_ms)
 VALUES(s.id,f.id,request_value->>'termsHash',bid,freshness);
 RETURN public.shardkeep_charter_sale_read(actor,sid);
END $$;

--> statement-breakpoint
-- Birth origin extends the existing exact chest proof; no fake raid is inserted.
ALTER TABLE public.clan_charter_raid_chest_heads ALTER COLUMN first_raid_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_head_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.clan_charter_raid_events%ROWTYPE;current_clan jsonb;difference bigint;w public.clan_charter_chest_updates%ROWTYPE;
BEGIN
 IF TG_RELID<>'public.clan_charter_raid_chest_heads'::regclass
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_TRIGGER';END IF;
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_READ_COMMITTED';END IF;
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_IMMUTABLE';END IF;
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE id=NEW.clan_id FOR UPDATE NOWAIT;
 IF TG_OP='INSERT' THEN
  IF NEW.first_raid_id IS NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.charter_sale_births b JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id
    JOIN public.charter_sale_clan_inserts ci ON ci.clan_id=b.clan_id WHERE b.clan_id=NEW.clan_id
    AND b.tx_key=pg_current_xact_id()::text AND ci.tx_key=b.tx_key AND ci.epoch_id=b.epoch_id
    AND b.original_terminal->'clan_snapshot'=current_clan AND ci.original_clan=current_clan)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_SOURCE';END IF;
   SELECT ep.rule_id INTO NEW.rule_id FROM public.charter_sale_births b JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id WHERE b.clan_id=NEW.clan_id;
   NEW.revision:=0;NEW.clan_state:=current_clan;RETURN NEW;
  END IF;
  SELECT * INTO e FROM public.clan_charter_raid_events WHERE raid_id=NEW.first_raid_id;
  IF NOT FOUND OR e.tithe_rule_id IS NULL OR e.original_clan_id IS DISTINCT FROM NEW.clan_id
   OR e.chest_admission_tx IS DISTINCT FROM pg_current_xact_id()::text OR current_clan IS NULL
   OR EXISTS(SELECT 1 FROM public.clan_charter_raid_events p WHERE p.original_clan_id=NEW.clan_id
    AND p.tithe_rule_id IS NOT NULL AND p.raid_id<>e.raid_id)
   OR NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_tithe_rules r WHERE r.id=e.tithe_rule_id AND r.source_id=e.source_id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_SOURCE';END IF;
  NEW.rule_id:=e.tithe_rule_id;NEW.revision:=0;NEW.clan_state:=current_clan;RETURN NEW;
 END IF;
 IF(NEW.clan_id,NEW.rule_id,NEW.first_raid_id) IS DISTINCT FROM(OLD.clan_id,OLD.rule_id,OLD.first_raid_id)
 OR OLD.clan_state IS NULL AND current_clan IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_IMMUTABLE';END IF;
 IF OLD.clan_state IS NOT DISTINCT FROM current_clan THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;RETURN OLD;
 END IF;
 IF NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.clan_state IS DISTINCT FROM current_clan THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
 IF current_clan IS NOT NULL THEN
  difference:=(current_clan->>'chest_shards')::bigint-(OLD.clan_state->>'chest_shards')::bigint;
  IF difference>0 THEN
   SELECT * INTO w FROM public.clan_charter_chest_updates WHERE actual_clan_id=OLD.clan_id AND chest_predecessor_revision=OLD.revision;
   IF NOT FOUND OR w.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR w.before_clan IS DISTINCT FROM OLD.clan_state
    OR w.after_clan IS DISTINCT FROM current_clan OR w.delta IS DISTINCT FROM difference
   THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PROOF';END IF;
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.clan_charter_raid_events event WHERE event.original_clan_id=OLD.clan_id
   AND public.shardkeep_clan_charter_raid_chest_proof(event.raid_id,true)->>'status' IS DISTINCT FROM 'reconciled')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_RAID_CHEST_PENDING';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_raid_chest_proof(rid uuid,terminal_required boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE e public.clan_charter_raid_events%ROWTYPE;r public.raids%ROWTYPE;rule public.clan_charter_raid_tithe_rules%ROWTYPE;
 h public.clan_charter_raid_chest_heads%ROWTYPE;t public.clan_charter_raid_terminals%ROWTYPE;p public.clan_charter_loot_posts%ROWTYPE;
 w public.clan_charter_chest_updates%ROWTYPE;ids uuid[];credits bigint;entries bigint;attack bigint;defend bigint;pool bigint;
 sum_delta numeric;gross numeric;net numeric;cut numeric;expected_cut numeric;valid boolean;current_clan jsonb;
BEGIN
 PERFORM public.shardkeep_clan_charter_raid_chest_owner();
 IF NOT public.shardkeep_clan_charter_raid_chest_hooks() THEN RETURN jsonb_build_object('status','held','reason','hooks_missing');END IF;
 SELECT * INTO e FROM public.clan_charter_raid_events WHERE raid_id=rid;
 IF NOT FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source) THEN RETURN jsonb_build_object('status','unenrolled');END IF;
  RETURN jsonb_build_object('status','held','reason','admission_missing');
 END IF;
 SELECT * INTO r FROM public.raids WHERE id=rid;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source WHERE source_id=e.source_id)
 OR(e.attacker_wallet,e.attacker_base_id,e.defender_wallet,e.defender_base_id,e.pve_camp_id,e.campaign_stage,e.admitted_at)
 IS DISTINCT FROM(r.attacker_wallet,r.attacker_base_id,r.defender_wallet,r.defender_base_id,r.pve_camp_id,r.campaign_stage,r.created_at)
 OR e.kind IS DISTINCT FROM(CASE WHEN r.campaign_stage IS NOT NULL THEN 'campaign' WHEN r.pve_camp_id IS NOT NULL THEN 'pve'
   WHEN r.attacker_base_id IS NOT NULL AND r.defender_base_id IS NOT NULL THEN 'deed_pvp' ELSE 'legacy_pvp' END)
 OR num_nonnulls(e.defender_wallet,e.pve_camp_id,e.campaign_stage)<>1 OR e.defender_wallet=e.attacker_wallet
 OR(e.defender_base_id IS NOT NULL AND e.defender_wallet IS NULL) OR e.campaign_stage<=0
 OR(e.original_clan_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.clan_charter_event_heads x WHERE x.clan_id=e.original_clan_id
  AND x.ordinal=(SELECT count(*) FROM public.clan_charter_raid_events n WHERE n.original_clan_id=e.original_clan_id)
  AND x.ordinal=(SELECT max(clan_ordinal) FROM public.clan_charter_raid_events n WHERE n.original_clan_id=e.original_clan_id)))
 THEN RETURN jsonb_build_object('status','held','reason','admission_mismatch');END IF;
 IF e.tithe_rule_id IS NULL THEN RETURN jsonb_build_object('status','held','reason','rule_missing');END IF;
 SELECT * INTO rule FROM public.clan_charter_raid_tithe_rules WHERE id=e.tithe_rule_id AND source_id=e.source_id;
 IF NOT FOUND OR rule.version<>1 OR rule.rate_source<>'CLANS.chestTitheBps' OR rule.tithe_bps<0 OR rule.basis_points<=rule.tithe_bps
 OR e.chest_admission_tx IS NULL THEN RETURN jsonb_build_object('status','held','reason','rule_mismatch');END IF;
 IF e.original_clan_id IS NOT NULL THEN
  SELECT * INTO h FROM public.clan_charter_raid_chest_heads WHERE clan_id=e.original_clan_id;
  SELECT to_jsonb(c) INTO current_clan FROM public.clans c WHERE id=e.original_clan_id;
  IF h.clan_id IS NULL OR h.rule_id IS DISTINCT FROM rule.id
   OR NOT(EXISTS(SELECT 1 FROM public.clan_charter_raid_events first_event WHERE first_event.raid_id=h.first_raid_id
    AND first_event.original_clan_id=h.clan_id AND first_event.tithe_rule_id=h.rule_id) OR(h.first_raid_id IS NULL AND EXISTS(SELECT 1 FROM public.charter_sale_births b
   JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id JOIN public.charter_sale_clan_inserts ci ON ci.clan_id=b.clan_id
   WHERE b.clan_id=h.clan_id AND ep.rule_id=h.rule_id AND ep.source_id=e.source_id AND ci.epoch_id=b.epoch_id AND ci.tx_key=b.tx_key)))
  THEN RETURN jsonb_build_object('status','held','reason','head_mismatch');END IF;
 END IF;
 SELECT * INTO t FROM public.clan_charter_raid_terminals WHERE raid_id=rid;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO ids FROM(
  SELECT ledger_id id FROM public.clan_charter_loot_posts WHERE raid_id=rid
  UNION SELECT id FROM public.ledger_transactions WHERE idempotency_key='raid:'||rid::text||':loot'
   OR(type='raid.loot' AND metadata->>'raidId'=rid::text)) found;
 IF t.raid_id IS NULL THEN
  IF NOT terminal_required AND cardinality(ids)=0 AND r.status IN('pending_orders','resolving') THEN RETURN jsonb_build_object('status','pending');END IF;
  RETURN jsonb_build_object('status','held','reason','terminal_missing');
 END IF;
 IF t.source_id IS DISTINCT FROM e.source_id OR t.after_raid IS DISTINCT FROM to_jsonb(r)
 OR t.after_raid->>'status' IS DISTINCT FROM t.terminal_status OR t.before_raid->>'id' IS DISTINCT FROM rid::text
 OR NOT((t.terminal_status='resolved' AND t.before_raid->>'status'='resolving' AND r.resolved_at IS NOT NULL)
  OR(t.terminal_status='expired' AND t.before_raid->>'status'='pending_orders'))
 OR jsonb_build_array(t.before_raid->'attacker_wallet',t.before_raid->'attacker_base_id',t.before_raid->'defender_wallet',t.before_raid->'defender_base_id',t.before_raid->'pve_camp_id',t.before_raid->'campaign_stage',t.before_raid->'created_at')
  IS DISTINCT FROM jsonb_build_array(t.after_raid->'attacker_wallet',t.after_raid->'attacker_base_id',t.after_raid->'defender_wallet',t.after_raid->'defender_base_id',t.after_raid->'pve_camp_id',t.after_raid->'campaign_stage',t.after_raid->'created_at')
 THEN RETURN jsonb_build_object('status','held','reason','terminal_mismatch');END IF;
 SELECT count(*) INTO credits FROM public.clan_charter_chest_updates c WHERE c.ledger_id=ANY(ids)
  OR c.candidate_ledger_ids&&ids OR(c.tx_key=t.tx_key AND c.ledger_id IS NULL);
 IF cardinality(ids)=0 THEN
  IF credits<>0 OR(t.terminal_status='resolved' AND e.kind='legacy_pvp' AND t.after_raid->'result'->>'lootShards' IS DISTINCT FROM '0')
  THEN RETURN jsonb_build_object('status','held','reason','loot_missing');END IF;
  cut:=0;
 ELSE
  IF cardinality(ids)<>1 OR e.kind<>'legacy_pvp' OR t.terminal_status<>'resolved' THEN RETURN jsonb_build_object('status','held','reason','unexpected_loot');END IF;
  SELECT * INTO p FROM public.clan_charter_loot_posts WHERE ledger_id=ids[1];
  IF NOT FOUND OR p.raid_id IS DISTINCT FROM rid OR p.source_id IS DISTINCT FROM e.source_id OR p.tx_key IS DISTINCT FROM t.tx_key
   OR NOT EXISTS(SELECT 1 FROM public.ledger_transactions actual WHERE actual.id=p.ledger_id AND actual.type='raid.loot'
    AND actual.idempotency_key='raid:'||rid::text||':loot' AND to_jsonb(actual)=p.original_transaction)
  THEN RETURN jsonb_build_object('status','held','reason','loot_mismatch');END IF;
  WITH all_ids AS(SELECT entry_id id FROM public.clan_charter_loot_entries WHERE ledger_id=p.ledger_id
    UNION SELECT id FROM public.ledger_entries WHERE txn_id=p.ledger_id), legs AS(
   SELECT actual.delta,a.kind,a.owner_wallet,a.currency,a.base_id,
    (saved.ledger_id=p.ledger_id AND saved.tx_key=p.tx_key AND saved.original_entry=to_jsonb(actual)
     AND saved.account_identity=to_jsonb(a)-'balance' AND actual.txn_id=p.ledger_id) okay
   FROM all_ids LEFT JOIN public.ledger_entries actual ON actual.id=all_ids.id
    LEFT JOIN public.accounts a ON a.id=actual.account_id LEFT JOIN public.clan_charter_loot_entries saved ON saved.entry_id=all_ids.id)
  SELECT count(*),bool_and(coalesce(okay,false) AND currency='SHARDS' AND base_id IS NULL),sum(delta),
   count(*) FILTER(WHERE kind='player_shards' AND owner_wallet=e.attacker_wallet AND delta>0),
   count(*) FILTER(WHERE kind='player_shards' AND owner_wallet=e.defender_wallet AND delta<0),
   count(*) FILTER(WHERE kind='clan_chest' AND owner_wallet IS NULL AND delta>0),
   sum(delta) FILTER(WHERE kind='player_shards' AND owner_wallet=e.attacker_wallet AND delta>0),
   -sum(delta) FILTER(WHERE kind='player_shards' AND owner_wallet=e.defender_wallet AND delta<0),
   coalesce(sum(delta) FILTER(WHERE kind='clan_chest' AND owner_wallet IS NULL AND delta>0),0)
  INTO entries,valid,sum_delta,attack,defend,pool,net,gross,cut FROM legs;
  expected_cut:=CASE WHEN e.original_clan_id IS NULL THEN 0 ELSE floor(gross*rule.tithe_bps/rule.basis_points) END;
  IF valid IS DISTINCT FROM true OR entries NOT IN(2,3) OR attack<>1 OR defend<>1 OR pool>1 OR entries<>attack+defend+pool
   OR sum_delta IS DISTINCT FROM 0::numeric OR cut IS DISTINCT FROM expected_cut
   OR t.after_raid->'result'->>'lootShards' IS DISTINCT FROM net::text
   OR p.original_transaction->'metadata' IS DISTINCT FROM jsonb_build_object('raidId',rid::text,'attacker',e.attacker_wallet,'defender',e.defender_wallet,'clanChest',cut::text)
  THEN RETURN jsonb_build_object('status','held','reason','loot_conservation');END IF;
  IF cut=0 THEN
   IF credits<>0 OR entries<>2 THEN RETURN jsonb_build_object('status','held','reason','unexpected_credit');END IF;
  ELSE
   SELECT * INTO w FROM public.clan_charter_chest_updates WHERE ledger_id=p.ledger_id;
   IF credits<>1 OR w.id IS NULL OR w.actual_clan_id IS DISTINCT FROM e.original_clan_id OR w.source_id IS DISTINCT FROM e.source_id
    OR w.tx_key IS DISTINCT FROM p.tx_key OR w.delta IS DISTINCT FROM cut OR w.pairing IS DISTINCT FROM 'matched'
    OR w.candidate_ledger_ids IS DISTINCT FROM ARRAY[p.ledger_id] OR w.chest_predecessor_revision IS NULL
    OR w.chest_predecessor_revision>=h.revision OR w.before_clan->>'id' IS DISTINCT FROM e.original_clan_id::text
    OR w.after_clan->>'id' IS DISTINCT FROM e.original_clan_id::text
    OR w.before_clan-'chest_shards' IS DISTINCT FROM w.after_clan-'chest_shards'
    OR (w.after_clan->>'chest_shards')::bigint-(w.before_clan->>'chest_shards')::bigint IS DISTINCT FROM w.delta
   THEN RETURN jsonb_build_object('status','held','reason','credit_mismatch');END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('status','reconciled','raidId',rid,'originalClanId',e.original_clan_id,'ruleId',rule.id,
  'terminalStatus',t.terminal_status,'chestShards',cut::text);
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_source(fid uuid,paid_source jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE f public.clan_charter_member_fences%ROWTYPE;h public.clan_charter_raid_chest_heads%ROWTYPE;
 w public.clan_charter_chest_updates%ROWTYPE;e public.clan_charter_raid_events%ROWTYPE;
 c jsonb;prehead jsonb;state jsonb;revision bigint;total bigint;roster jsonb;eligible text[];allocations jsonb;
 historical boolean:=false;release public.charter_sale_fence_releases%ROWTYPE;terminal public.charter_sale_terminals%ROWTYPE;
 witnesses jsonb:='[]'::jsonb;events jsonb:='[]'::jsonb;proof jsonb;n bigint;
BEGIN
 PERFORM public.shardkeep_charter_member_payment_owner();PERFORM public.shardkeep_charter_member_payment_hooks();
 SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=fid;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_NOT_FOUND';END IF;
 SELECT * INTO release FROM public.charter_sale_fence_releases WHERE fence_id=fid;
 IF release.fence_id IS NOT NULL AND paid_source IS NOT NULL THEN
  IF NOT public.shardkeep_charter_sale_released(fid) OR release.payment_source IS DISTINCT FROM paid_source
   OR paid_source->'fence' IS DISTINCT FROM to_jsonb(f)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  SELECT * INTO terminal FROM public.charter_sale_terminals WHERE sale_id=release.sale_id;
  historical:=true;
 END IF;
 SELECT to_jsonb(live) INTO c FROM public.clans live WHERE id=f.clan_id;
 SELECT * INTO h FROM public.clan_charter_raid_chest_heads WHERE clan_id=f.clan_id;
 IF historical THEN
  IF (paid_source->'headBefore')-ARRAY['revision','clan_state'] IS DISTINCT FROM to_jsonb(h)-ARRAY['revision','clan_state']
   OR h.revision<(paid_source->'headBefore'->>'revision')::bigint
   OR terminal.clan_before IS DISTINCT FROM jsonb_set(paid_source->'headBefore'->'clan_state','{chest_shards}','0'::jsonb)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  h:=jsonb_populate_record(NULL::public.clan_charter_raid_chest_heads,paid_source->'headBefore');
  c:=terminal.clan_before;h.clan_state:=c;h.revision:=h.revision+CASE WHEN(paid_source->>'totalShards')::bigint>0 THEN 1 ELSE 0 END;
 END IF;
 IF h.clan_id IS NULL OR c IS NULL OR h.clan_state IS DISTINCT FROM c OR h.clan_state IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source WHERE source_id=f.source_id)
 OR f.original_clan->>'id' IS DISTINCT FROM f.clan_id::text OR f.original_clan->>'leader_wallet' IS DISTINCT FROM f.actor_wallet
 OR(f.original_clan->>'chest_shards')::bigint IS DISTINCT FROM f.chest_shards
 OR f.original_clan-'chest_shards' IS DISTINCT FROM c-'chest_shards'
 OR NOT(EXISTS(SELECT 1 FROM public.clan_charter_raid_events first_event WHERE first_event.raid_id=h.first_raid_id
  AND first_event.original_clan_id=h.clan_id AND first_event.tithe_rule_id=h.rule_id) OR(h.first_raid_id IS NULL AND EXISTS(SELECT 1 FROM public.charter_sale_births b
   JOIN public.charter_sale_epochs ep ON ep.id=b.epoch_id JOIN public.charter_sale_clan_inserts ci ON ci.clan_id=b.clan_id
   WHERE b.clan_id=h.clan_id AND ep.rule_id=h.rule_id AND ep.source_id=f.source_id AND ci.epoch_id=b.epoch_id AND ci.tx_key=b.tx_key)))
 OR f.raid_ordinal IS DISTINCT FROM(SELECT count(*) FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id AND(NOT historical OR clan_ordinal<=f.raid_ordinal))
 OR f.raid_ordinal IS DISTINCT FROM coalesce((SELECT max(clan_ordinal) FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id AND(NOT historical OR clan_ordinal<=f.raid_ordinal)),0)
 OR(NOT historical AND f.raid_ordinal IS DISTINCT FROM coalesce((SELECT ordinal FROM public.clan_charter_event_heads WHERE clan_id=f.clan_id),0))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 prehead:=coalesce(paid_source->'headBefore',to_jsonb(h));state:=prehead->'clan_state';revision:=(prehead->>'revision')::bigint;
 total:=(state->>'chest_shards')::bigint;
 IF total IS NULL OR total<f.chest_shards OR revision IS NULL OR revision<0
 OR prehead-ARRAY['clan_state','revision'] IS DISTINCT FROM to_jsonb(h)-ARRAY['clan_state','revision']
 OR state-'chest_shards' IS DISTINCT FROM c-'chest_shards'
 OR(paid_source IS NOT NULL AND(h.revision IS DISTINCT FROM revision+CASE WHEN total>0 THEN 1 ELSE 0 END
  OR c IS DISTINCT FROM jsonb_set(state,'{chest_shards}','0'::jsonb)))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.member_wallet COLLATE "C"),'[]'::jsonb),
  coalesce(array_agg(m.member_wallet ORDER BY m.member_wallet COLLATE "C") FILTER(WHERE m.eligible),'{}'::text[])
 INTO roster,eligible FROM public.clan_charter_member_roster m WHERE m.fence_id=fid;
 IF jsonb_array_length(roster)<>f.roster_count OR cardinality(eligible)<>f.eligible_count
 OR(NOT historical AND f.roster_count<>(SELECT count(*) FROM public.clan_members WHERE clan_id=f.clan_id))
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_member_roster WHERE fence_id=fid AND member_wallet=f.actor_wallet)
 OR EXISTS(SELECT 1 FROM public.clan_charter_member_roster m LEFT JOIN public.clan_members live ON live.player_wallet=m.member_wallet
  WHERE m.fence_id=fid AND((NOT historical AND(m.original_membership IS DISTINCT FROM to_jsonb(live) OR live.clan_id IS DISTINCT FROM f.clan_id))
   OR m.original_membership->>'player_wallet' IS DISTINCT FROM m.member_wallet
   OR(m.eligible AND(m.original_base->>'id' IS DISTINCT FROM m.base_id::text OR m.base_id IS NULL OR m.slot IS NULL OR m.slot<=0
    OR m.original_base->>'owner_wallet' IS DISTINCT FROM m.member_wallet OR m.original_base->>'status' IS DISTINCT FROM 'active'
    OR m.original_base->>'land_paid_at' IS NULL OR m.original_slot->>'base_id' IS DISTINCT FROM m.base_id::text
    OR m.original_slot->>'wallet' IS DISTINCT FROM m.member_wallet OR m.original_slot->>'active' IS DISTINCT FROM 'true'
    OR m.original_slot->>'slot' IS DISTINCT FROM m.slot::text))
   OR(NOT m.eligible AND num_nonnulls(m.base_id,m.slot,m.original_base,m.original_slot)<>0)))
 OR(total>0 AND cardinality(eligible)=0)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 FOR e IN SELECT * FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id AND clan_ordinal<=f.raid_ordinal ORDER BY clan_ordinal LOOP
  proof:=public.shardkeep_clan_charter_raid_chest_proof(e.raid_id,true);
  IF e.source_id IS DISTINCT FROM f.source_id OR e.tithe_rule_id IS DISTINCT FROM h.rule_id
   OR proof->>'status' IS DISTINCT FROM 'reconciled' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  events:=events||jsonb_build_array(jsonb_build_object('event',to_jsonb(e),'proof',proof));
 END LOOP;
 WHILE state IS DISTINCT FROM f.original_clan LOOP
  IF revision<=0 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  SELECT * INTO w FROM public.clan_charter_chest_updates WHERE actual_clan_id=f.clan_id AND chest_predecessor_revision=revision-1;
  IF NOT FOUND OR w.source_id IS DISTINCT FROM f.source_id OR w.delta<=0 OR w.after_clan IS DISTINCT FROM state
   OR w.before_clan-'chest_shards' IS DISTINCT FROM state-'chest_shards'
   OR(w.after_clan->>'chest_shards')::bigint-(w.before_clan->>'chest_shards')::bigint IS DISTINCT FROM w.delta
   OR NOT EXISTS(SELECT 1 FROM public.clan_charter_loot_posts p JOIN public.clan_charter_raid_events r ON r.raid_id=p.raid_id
    WHERE p.ledger_id=w.ledger_id AND r.original_clan_id=f.clan_id AND r.clan_ordinal<=f.raid_ordinal
     AND public.shardkeep_clan_charter_raid_chest_proof(r.raid_id,true)->>'status'='reconciled')
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  witnesses:=witnesses||jsonb_build_array(to_jsonb(w));state:=w.before_clan;revision:=revision-1;
 END LOOP;
 n:=cardinality(eligible);
 IF n=0 THEN
  -- The zero-chest/empty-eligible case is valid. Do not rely on an empty
  -- unnest to prevent PostgreSQL from evaluating division by zero.
  allocations:='[]'::jsonb;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',wallet,'shards',
   (total/n+CASE WHEN position<=total%n THEN 1 ELSE 0 END)::text) ORDER BY position),'[]'::jsonb)
  INTO allocations FROM unnest(eligible) WITH ORDINALITY x(wallet,position);
 END IF;
 RETURN jsonb_build_object('fence',to_jsonb(f),'roster',roster,'headBefore',prehead,'witnesses',witnesses,'events',events,
  'startRevision',revision::text,'totalShards',total::text,'allocations',allocations);
END $$;

ALTER TABLE public.clan_charter_member_fences DROP CONSTRAINT IF EXISTS clan_charter_member_fences_clan_id_key;
ALTER TABLE public.clan_charter_member_payments DROP CONSTRAINT IF EXISTS clan_charter_member_payments_clan_id_key;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_member_fence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE source uuid;c public.clans%ROWTYPE;h public.clan_charter_member_fences%ROWTYPE;
 n bigint;highest bigint;head bigint;selected_base uuid;selected_slot integer;selected_base_json jsonb;selected_slot_json jsonb;
BEGIN
 IF TG_RELID NOT IN('public.clan_charter_member_fences'::regclass,'public.clan_charter_member_roster'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW') THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_TRIGGER';END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_IMMUTABLE';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_OWNER' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_READ_COMMITTED';END IF;
 IF TG_TABLE_NAME='clan_charter_member_fences' THEN
  SELECT source_id INTO source FROM public.clan_charter_event_source;IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SOURCE_REQUIRED';END IF;
  -- Exact snapshot barriers precede the clan/head mutex. NOWAIT prevents lock
  -- inversion with existing gameplay writers; no player or provider work here.
  LOCK TABLE public.clan_members,public.bases,public.base_slots IN SHARE MODE NOWAIT;
  SELECT * INTO c FROM public.clans WHERE id=NEW.clan_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR c.leader_wallet IS DISTINCT FROM NEW.actor_wallet OR NOT EXISTS(SELECT 1 FROM public.clan_members WHERE clan_id=c.id AND player_wallet=NEW.actor_wallet)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_LEADER';END IF;
  IF EXISTS(SELECT 1 FROM public.clan_charter_member_fences prior WHERE prior.clan_id=c.id AND NOT public.shardkeep_charter_sale_released(prior.id))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_FENCED';END IF;
  SELECT ordinal INTO head FROM public.clan_charter_event_heads WHERE clan_id=c.id FOR UPDATE NOWAIT;
  SELECT count(*),coalesce(max(clan_ordinal),0) INTO n,highest FROM public.clan_charter_raid_events WHERE original_clan_id=c.id;
  IF coalesce(head,0)<>n OR highest<>n OR EXISTS(SELECT 1 FROM public.clan_charter_raid_events e LEFT JOIN public.raids r ON r.id=e.raid_id WHERE e.original_clan_id=c.id
   AND(e.source_id IS DISTINCT FROM source OR r.id IS NULL OR(e.attacker_wallet,e.attacker_base_id,e.defender_wallet,e.defender_base_id,e.pve_camp_id,e.campaign_stage,e.admitted_at)
    IS DISTINCT FROM(r.attacker_wallet,r.attacker_base_id,r.defender_wallet,r.defender_base_id,r.pve_camp_id,r.campaign_stage,r.created_at)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_PREFIX';END IF;
  IF NEW.idempotency_key LIKE 'charter-sale:%' THEN
   SELECT (s.original->>'fenceId')::uuid INTO NEW.id FROM public.charter_sales s WHERE 'charter-sale:'||s.id::text=NEW.idempotency_key
    AND s.seller=NEW.actor_wallet AND s.clan_id=NEW.clan_id AND NOT EXISTS(SELECT 1 FROM public.charter_sale_terminals t WHERE t.sale_id=s.id);
   IF NEW.id IS NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_SALE_SOURCE';END IF;
  ELSE NEW.id:=gen_random_uuid();END IF;NEW.source_id:=source;NEW.raid_ordinal:=n;NEW.original_clan:=to_jsonb(c);NEW.chest_shards:=c.chest_shards;NEW.created_at:=clock_timestamp();
  SELECT count(*),count(*) FILTER(WHERE EXISTS(SELECT 1 FROM public.base_slots s JOIN public.bases b ON b.id=s.base_id
   WHERE s.wallet=m.player_wallet AND s.active AND b.owner_wallet=m.player_wallet AND b.status='active' AND b.land_paid_at IS NOT NULL))
   INTO NEW.roster_count,NEW.eligible_count FROM public.clan_members m WHERE m.clan_id=c.id;
  RETURN NEW;
 END IF;
 IF pg_trigger_depth()<>2 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.clan_charter_member_fences'::regclass AND tgname='clan_charter_member_fences_capture_roster'
  AND tgfoid='public.shardkeep_clan_charter_capture_member_roster()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_ORIGIN' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT h FROM public.clan_charter_member_fences WHERE id=NEW.fence_id;
 IF NOT EXISTS(SELECT 1 FROM public.clan_members m WHERE m.player_wallet=NEW.member_wallet AND m.clan_id=h.clan_id AND to_jsonb(m)=NEW.original_membership) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_ROSTER';END IF;
 SELECT b.id,s.slot,to_jsonb(b),to_jsonb(s) INTO selected_base,selected_slot,selected_base_json,selected_slot_json
 FROM public.base_slots s JOIN public.bases b ON b.id=s.base_id WHERE s.wallet=NEW.member_wallet AND s.active AND b.owner_wallet=NEW.member_wallet AND b.status='active' AND b.land_paid_at IS NOT NULL ORDER BY s.slot,b.id LIMIT 1;
 IF(NEW.eligible,NEW.base_id,NEW.slot,NEW.original_base,NEW.original_slot) IS DISTINCT FROM(selected_base IS NOT NULL,selected_base,selected_slot,selected_base_json,selected_slot_json) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_ROSTER';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_member_fence_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE affected uuid[];clan uuid;payment public.clan_charter_member_payments%ROWTYPE;active_fence uuid;
BEGIN
 IF TG_RELID NOT IN('public.clans'::regclass,'public.clan_members'::regclass,'public.clan_charter_raid_events'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_charter_member_fence_truncate' ELSE '_charter_member_fence' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME AND tgfoid='public.shardkeep_clan_charter_member_fence_boundary()'::regprocedure AND tgenabled='O') THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_TRIGGER';END IF;
 -- This must precede fence lookup: an old RR snapshot must never hide a newly
 -- committed fence, including while all feature flags are off.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_READ_COMMITTED';END IF;
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.clan_charter_member_fences) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_FENCED';END IF;RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='clan_charter_raid_events' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_TRIGGER';END IF;affected:=ARRAY[NEW.original_clan_id];
 ELSIF TG_TABLE_NAME='clan_members' THEN
  IF TG_OP='INSERT' THEN affected:=ARRAY[NEW.clan_id];ELSIF TG_OP='DELETE' THEN affected:=ARRAY[OLD.clan_id];ELSE affected:=ARRAY[OLD.clan_id,NEW.clan_id];END IF;
 ELSE
  IF TG_OP='DELETE' THEN affected:=ARRAY[OLD.id];ELSE affected:=ARRAY[OLD.id,NEW.id];END IF;
 END IF;
 FOR clan IN SELECT DISTINCT id FROM unnest(affected) id WHERE id IS NOT NULL ORDER BY id LOOP
  PERFORM 1 FROM public.clans WHERE id=clan FOR UPDATE NOWAIT;
  SELECT id INTO active_fence FROM public.clan_charter_member_fences f WHERE f.clan_id=clan AND NOT public.shardkeep_charter_sale_released(f.id);
  IF active_fence IS NOT NULL THEN
   IF public.shardkeep_charter_sale_projection(TG_TABLE_NAME,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END) THEN CONTINUE;END IF;
   SELECT * INTO payment FROM public.clan_charter_member_payments WHERE fence_id=active_fence;
   IF TG_TABLE_NAME='clans' AND TG_OP='UPDATE' THEN
    -- The sole extraction exception is the actual same-transaction payout.
    -- Retained positive credits cannot refill a finalized member chest.
    IF payment.id IS NOT NULL AND payment.tx_key=pg_current_xact_id()::text
     AND NEW.chest_shards=0 AND OLD.chest_shards=payment.total_shards AND OLD.chest_shards>0
     AND to_jsonb(OLD)=payment.source->'headBefore'->'clan_state'
     AND to_jsonb(NEW)-'chest_shards'=to_jsonb(OLD)-'chest_shards' THEN
      PERFORM public.shardkeep_charter_member_payment_validate(payment.id,false);CONTINUE;
    END IF;
    IF payment.id IS NULL AND NEW.chest_shards>OLD.chest_shards
     AND to_jsonb(NEW)-'chest_shards'=to_jsonb(OLD)-'chest_shards' THEN CONTINUE;END IF;
   END IF;
   RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_FENCED';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
--> statement-breakpoint
DO $$DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['charter_sale_epochs','charter_sale_clan_inserts','charter_sale_births','charter_sale_heads','charter_sales','charter_sale_inventory_heads',
  'charter_sale_fence_origins','charter_sale_acceptances','charter_sale_attempts','charter_sale_preparations','charter_sale_wires','charter_sale_terminals',
  'charter_sale_fence_releases','charter_sale_effects','charter_sale_ante_posts','charter_sale_ante_entries','charter_sale_ante_effects','charter_sale_raid_admissions','charter_sale_raid_outcomes'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',tab);
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_sale_private()',tab||'_guard',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_sale_private()',tab||'_no_truncate',tab);END IF;
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['charter_creation_terminals','charter_sales','clan_charter_member_fences','charter_sale_attempts','charter_sale_terminals'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_charter_sale_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_sale_capture()',tab||'_charter_sale_capture',tab);END IF;
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['clans','clan_members','ledger_transactions','ledger_entries','accounts','raids'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_charter_sale_source') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_sale_source()',tab||'_charter_sale_source',tab);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_charter_sale_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_sale_source()',tab||'_charter_sale_no_truncate',tab);END IF;
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['charter_sale_clan_inserts','charter_sale_births','charter_sales','charter_sale_inventory_heads','charter_sale_fence_origins',
  'charter_sale_acceptances','charter_sale_attempts','charter_sale_preparations','charter_sale_wires','charter_sale_terminals','charter_sale_fence_releases','charter_sale_effects','charter_sale_heads','charter_sale_ante_posts','charter_sale_ante_entries','charter_sale_ante_effects','charter_sale_raid_admissions','charter_sale_raid_outcomes','ledger_transactions','ledger_entries','accounts','raids','clans','clan_members','bases','base_slots','base_raid_locks','deed_ownership_observations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_charter_sale_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_sale_complete()',tab||'_charter_sale_complete',tab);END IF;
 END LOOP;
 FOR fn IN SELECT * FROM(VALUES('ledger_transactions','INSERT'),('ledger_entries','INSERT'),('accounts','UPDATE'),('clan_charter_raid_events','INSERT'),('raids','UPDATE')) fields(tab,event) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||fn.tab)::regclass AND tgname=fn.tab||'_charter_sale_ante_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_sale_ante_capture()',fn.tab||'_charter_sale_ante_capture',fn.event,fn.tab);END IF;
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['clans','clan_members','charter_sale_heads'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tab)::regclass AND tgname=tab||'_charter_sale_effect_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_sale_effect_capture()',tab||'_charter_sale_effect_capture',tab);END IF;
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_sale_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
 END LOOP;
 PERFORM public.shardkeep_charter_sale_hooks();
END $$;
