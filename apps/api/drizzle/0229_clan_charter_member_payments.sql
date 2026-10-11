-- D153.172: private members-first full chest payout. Existing-table hooks and
-- the narrow member-fence exception remain S5-held. No transfer/unlock permit.
SET LOCAL lock_timeout='10s';
CREATE TABLE IF NOT EXISTS public.clan_charter_member_payments(
 id uuid PRIMARY KEY,fence_id uuid NOT NULL UNIQUE REFERENCES public.clan_charter_member_fences(id),
 clan_id uuid NOT NULL UNIQUE,actor_wallet text NOT NULL,tx_key text NOT NULL,
 source jsonb NOT NULL,total_shards bigint NOT NULL CHECK(total_shards>=0),
 destinations jsonb NOT NULL,allocations jsonb NOT NULL,pool_account_id uuid NOT NULL,pool_identity jsonb NOT NULL,pool_before bigint NOT NULL,
 freshness_ms integer NOT NULL CHECK(freshness_ms>0),paid_at timestamptz NOT NULL CHECK(isfinite(paid_at))
);
CREATE INDEX IF NOT EXISTS clan_charter_member_payments_tx ON public.clan_charter_member_payments(tx_key);
CREATE TABLE IF NOT EXISTS public.clan_charter_member_posts(
 ledger_id uuid PRIMARY KEY REFERENCES public.ledger_transactions(id),payment_id uuid NOT NULL UNIQUE REFERENCES public.clan_charter_member_payments(id),
 tx_key text NOT NULL,original_transaction jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.clan_charter_member_entries(
 entry_id bigint PRIMARY KEY REFERENCES public.ledger_entries(id),payment_id uuid NOT NULL REFERENCES public.clan_charter_member_payments(id),
 tx_key text NOT NULL,original_entry jsonb NOT NULL,account_identity jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.clan_charter_member_effects(
 payment_id uuid NOT NULL REFERENCES public.clan_charter_member_payments(id),kind text NOT NULL CHECK(kind IN('accounts','clans')),
 target_id uuid NOT NULL,tx_key text NOT NULL,before_row jsonb NOT NULL,after_row jsonb NOT NULL,
 PRIMARY KEY(payment_id,kind,target_id)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_owner() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_READ_COMMITTED';END IF;
 IF current_user<>session_user OR current_user IS DISTINCT FROM(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.clan_charter_member_payments'::regclass)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_OWNER' USING ERRCODE='42501';END IF;
END $$;

-- Original eligibility is frozen; current receiving authority is selected only
-- for a positive share. Zero shares retain the beneficiary but move no value.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_destination(beneficiary text,bid uuid,fresh integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE b public.bases%ROWTYPE;s public.base_slots%ROWTYPE;o public.deed_ownership_observations%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_member_payment_owner();
 SELECT * INTO b FROM public.bases WHERE id=bid;
 SELECT * INTO s FROM public.base_slots WHERE base_id=bid AND base_slots.wallet=beneficiary AND active;
 SELECT * INTO o FROM public.deed_ownership_observations WHERE base_id=bid;
 IF b.id IS NULL OR b.owner_wallet IS DISTINCT FROM beneficiary OR b.status<>'active' OR b.land_paid_at IS NULL OR b.deed_asset_id IS NULL
 OR s.base_id IS NULL OR fresh IS NULL OR fresh<=0 OR EXISTS(SELECT 1 FROM public.base_raid_locks WHERE base_id=bid)
 OR EXISTS(SELECT 1 FROM public.raids WHERE attacker_base_id=bid AND status IN('pending_orders','resolving'))
 OR o.id IS NULL OR o.asset_id IS DISTINCT FROM b.deed_asset_id OR o.owner IS DISTINCT FROM beneficiary OR o.status<>'owned'
 OR public.shardkeep_charter_custody_proof(o) IS NOT TRUE OR o.checked_at>clock_timestamp()
 OR clock_timestamp()-o.checked_at>fresh*interval '1 millisecond'
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_DESTINATION';END IF;
 RETURN jsonb_build_object('base',to_jsonb(b),'slot',to_jsonb(s),'observation',to_jsonb(o));
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_private() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE f public.clan_charter_member_fences%ROWTYPE;p public.clan_charter_member_payments%ROWTYPE;
 t public.ledger_transactions%ROWTYPE;e public.ledger_entries%ROWTYPE;a public.accounts%ROWTYPE;
 s jsonb;allocation jsonb;destination jsonb;authority jsonb;all_allocations jsonb:='[]'::jsonb;
 pool public.accounts%ROWTYPE;ids uuid[];key uuid;beneficiary text;amount bigint;
BEGIN
 IF TG_RELID NOT IN('public.clan_charter_member_payments'::regclass,'public.clan_charter_member_posts'::regclass,
  'public.clan_charter_member_entries'::regclass,'public.clan_charter_member_effects'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_no_truncate' ELSE '_guard' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_TRIGGER';END IF;
 PERFORM public.shardkeep_charter_member_payment_owner();PERFORM public.shardkeep_charter_member_payment_hooks();
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='clan_charter_member_payments' THEN
  SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=NEW.fence_id AND actor_wallet=NEW.actor_wallet;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_NOT_FOUND';END IF;
  IF jsonb_typeof(NEW.destinations) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_DESTINATION';END IF;
  -- All receiver identities precede the global attribution barrier. Canonical
  -- destination/account identity is rederived after these locks, never copied
  -- from a caller's account/amount assertion or an earlier advisory plan.
  PERFORM wallet FROM public.players WHERE wallet IN(SELECT member_wallet FROM public.clan_charter_member_roster WHERE fence_id=f.id)
   ORDER BY wallet COLLATE "C" FOR UPDATE NOWAIT;
  FOR key IN SELECT DISTINCT(value->>'baseId')::uuid FROM jsonb_array_elements(NEW.destinations) ORDER BY 1 LOOP
   PERFORM id FROM public.bases WHERE id=key FOR UPDATE NOWAIT;
   PERFORM base_id FROM public.base_slots WHERE base_id=key FOR UPDATE NOWAIT;
   PERFORM id FROM public.deed_ownership_observations WHERE base_id=key FOR UPDATE NOWAIT;
  END LOOP;
  LOCK TABLE public.clans IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  PERFORM id FROM public.clans WHERE id=f.clan_id FOR UPDATE NOWAIT;
  PERFORM id FROM public.clan_charter_member_fences WHERE id=f.id FOR UPDATE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.clan_charter_member_payments WHERE fence_id=f.id) THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_BUSY';END IF;
  s:=public.shardkeep_charter_member_payment_source(f.id);
  NEW.id:=gen_random_uuid();NEW.clan_id:=f.clan_id;NEW.source:=s;NEW.total_shards:=(s->>'totalShards')::bigint;
  NEW.tx_key:=pg_current_xact_id()::text;NEW.paid_at:=clock_timestamp();
  NEW.freshness_ms:=current_setting('shardkeep.deed_mutation_freshness_ms')::integer;
  IF NEW.freshness_ms IS NULL OR NEW.freshness_ms<=0 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_DESTINATION';END IF;
  IF jsonb_array_length(NEW.destinations)<>(SELECT count(*) FROM jsonb_array_elements(s->'allocations') x WHERE(x->>'shards')::bigint>0)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.destinations) d WHERE jsonb_typeof(d)<>'object'
    OR d IS DISTINCT FROM jsonb_build_object('wallet',d->>'wallet','baseId',d->>'baseId')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'allocations') x WHERE x->>'wallet'=d->>'wallet' AND(x->>'shards')::bigint>0))
   OR(SELECT count(DISTINCT value->>'wallet') FROM jsonb_array_elements(NEW.destinations))<>jsonb_array_length(NEW.destinations)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_DESTINATION';END IF;
  SELECT * INTO pool FROM public.accounts WHERE kind='clan_chest' AND currency='SHARDS' AND owner_wallet IS NULL AND base_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  ids:=ARRAY[pool.id];
  FOR allocation IN SELECT value FROM jsonb_array_elements(s->'allocations') LOOP
   beneficiary:=allocation->>'wallet';amount:=(allocation->>'shards')::bigint;
   IF amount=0 THEN
    all_allocations:=all_allocations||jsonb_build_array(allocation||jsonb_build_object('baseId',NULL,'accountId',NULL,'authority',NULL,'accountIdentity',NULL,'accountBefore',NULL));CONTINUE;
   END IF;
   SELECT value INTO destination FROM jsonb_array_elements(NEW.destinations) WHERE value->>'wallet'=beneficiary;
   key:=(destination->>'baseId')::uuid;authority:=public.shardkeep_charter_member_payment_destination(beneficiary,key,NEW.freshness_ms);
   SELECT * INTO a FROM public.accounts WHERE kind='base_shards' AND base_id=key AND currency='SHARDS' AND owner_wallet IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_DESTINATION';END IF;
   ids:=array_append(ids,a.id);
   all_allocations:=all_allocations||jsonb_build_array(allocation||jsonb_build_object('baseId',key,'accountId',a.id,'authority',authority,'accountIdentity',to_jsonb(a)-'balance'));
  END LOOP;
  PERFORM id FROM public.accounts WHERE id=ANY(ids) ORDER BY id FOR UPDATE NOWAIT;
  SELECT * INTO STRICT pool FROM public.accounts WHERE id=pool.id;
  IF pool.balance IS DISTINCT FROM(SELECT coalesce(sum(chest_shards),0) FROM public.clans)
   OR pool.balance<NEW.total_shards THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  SELECT coalesce(jsonb_agg(value||jsonb_build_object('accountBefore',CASE WHEN value->>'accountId' IS NULL THEN NULL
   ELSE(SELECT balance::text FROM public.accounts WHERE id=(value->>'accountId')::uuid) END) ORDER BY ord),'[]'::jsonb)
  INTO NEW.allocations FROM jsonb_array_elements(all_allocations) WITH ORDINALITY x(value,ord);
  NEW.pool_account_id:=pool.id;NEW.pool_identity:=to_jsonb(pool)-'balance';NEW.pool_before:=pool.balance;RETURN NEW;
 END IF;
 -- Only mandatory canonical AFTER hooks can create retained actual effects.
 -- A copied TEMP hook cannot bypass the live canonical hook or unique witness.
 IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_ORIGIN';END IF;
 IF TG_TABLE_NAME='clan_charter_member_posts' THEN
  SELECT * INTO STRICT t FROM public.ledger_transactions WHERE id=NEW.ledger_id;
  SELECT * INTO p FROM public.clan_charter_member_payments WHERE id=(t.metadata->>'paymentId')::uuid;
  IF p.id IS NULL OR p.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR p.total_shards<=0
   OR t.type IS DISTINCT FROM 'clan.charter.member_settlement' OR t.idempotency_key IS DISTINCT FROM 'clan-charter:member-payment:'||p.id::text
   OR t.metadata IS DISTINCT FROM jsonb_build_object('paymentId',p.id,'fenceId',p.fence_id,'clanId',p.clan_id,'actorWallet',p.actor_wallet,'totalShards',p.total_shards::text)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  NEW.payment_id:=p.id;NEW.tx_key:=p.tx_key;NEW.original_transaction:=to_jsonb(t);RETURN NEW;
 ELSIF TG_TABLE_NAME='clan_charter_member_entries' THEN
  SELECT * INTO STRICT e FROM public.ledger_entries WHERE id=NEW.entry_id;
  SELECT payment.* INTO p FROM public.clan_charter_member_payments payment JOIN public.clan_charter_member_posts post ON post.payment_id=payment.id WHERE post.ledger_id=e.txn_id;
  SELECT * INTO STRICT a FROM public.accounts WHERE id=e.account_id;
  IF p.id IS NULL OR p.tx_key IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  NEW.payment_id:=p.id;NEW.tx_key:=p.tx_key;NEW.original_entry:=to_jsonb(e);NEW.account_identity:=to_jsonb(a)-'balance';RETURN NEW;
 END IF;
 SELECT * INTO p FROM public.clan_charter_member_payments WHERE id=NEW.payment_id;
 IF p.id IS NULL OR p.tx_key IS DISTINCT FROM pg_current_xact_id()::text OR NEW.tx_key IS DISTINCT FROM p.tx_key
  OR NEW.before_row->>'id' IS DISTINCT FROM NEW.target_id::text OR NEW.after_row->>'id' IS DISTINCT FROM NEW.target_id::text
  OR(NEW.kind='accounts' AND NOT EXISTS(SELECT 1 FROM public.accounts actual WHERE id=NEW.target_id AND to_jsonb(actual)=NEW.after_row))
  OR(NEW.kind='clans' AND NOT EXISTS(SELECT 1 FROM public.clans actual WHERE id=NEW.target_id AND to_jsonb(actual)=NEW.after_row))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_begin(fid uuid,actor text,selected jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p public.clan_charter_member_payments%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_member_payment_owner();
 INSERT INTO public.clan_charter_member_payments(fence_id,actor_wallet,destinations) VALUES(fid,actor,selected) RETURNING * INTO p;
 RETURN jsonb_build_object('id',p.id,'fenceId',p.fence_id,'clanId',p.clan_id,'actorWallet',p.actor_wallet,
  'totalShards',p.total_shards::text,'poolAccountId',p.pool_account_id,'allocations',
  (SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',value->>'wallet','shards',value->>'shards','baseId',value->'baseId','accountId',value->'accountId') ORDER BY ord),'[]'::jsonb)
   FROM jsonb_array_elements(p.allocations) WITH ORDINALITY x(value,ord)));
END $$;

-- Saved pre-payment head is accepted only for immutable receipt verification.
-- It must lead to the exact current paid head; it is never new-work authority.
CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_source(fid uuid,paid_source jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE f public.clan_charter_member_fences%ROWTYPE;h public.clan_charter_raid_chest_heads%ROWTYPE;
 w public.clan_charter_chest_updates%ROWTYPE;e public.clan_charter_raid_events%ROWTYPE;
 c jsonb;prehead jsonb;state jsonb;revision bigint;total bigint;roster jsonb;eligible text[];allocations jsonb;
 witnesses jsonb:='[]'::jsonb;events jsonb:='[]'::jsonb;proof jsonb;n bigint;
BEGIN
 PERFORM public.shardkeep_charter_member_payment_owner();PERFORM public.shardkeep_charter_member_payment_hooks();
 SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=fid;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_NOT_FOUND';END IF;
 SELECT to_jsonb(live) INTO c FROM public.clans live WHERE id=f.clan_id;
 SELECT * INTO h FROM public.clan_charter_raid_chest_heads WHERE clan_id=f.clan_id;
 IF h.clan_id IS NULL OR c IS NULL OR h.clan_state IS DISTINCT FROM c OR h.clan_state IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_event_source WHERE source_id=f.source_id)
 OR f.original_clan->>'id' IS DISTINCT FROM f.clan_id::text OR f.original_clan->>'leader_wallet' IS DISTINCT FROM f.actor_wallet
 OR(f.original_clan->>'chest_shards')::bigint IS DISTINCT FROM f.chest_shards
 OR f.original_clan-'chest_shards' IS DISTINCT FROM c-'chest_shards'
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_raid_events first_event WHERE first_event.raid_id=h.first_raid_id
  AND first_event.original_clan_id=h.clan_id AND first_event.tithe_rule_id=h.rule_id)
 OR f.raid_ordinal IS DISTINCT FROM(SELECT count(*) FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id)
 OR f.raid_ordinal IS DISTINCT FROM coalesce((SELECT max(clan_ordinal) FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id),0)
 OR f.raid_ordinal IS DISTINCT FROM coalesce((SELECT ordinal FROM public.clan_charter_event_heads WHERE clan_id=f.clan_id),0)
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
 OR f.roster_count<>(SELECT count(*) FROM public.clan_members WHERE clan_id=f.clan_id)
 OR NOT EXISTS(SELECT 1 FROM public.clan_charter_member_roster WHERE fence_id=fid AND member_wallet=f.actor_wallet)
 OR EXISTS(SELECT 1 FROM public.clan_charter_member_roster m LEFT JOIN public.clan_members live ON live.player_wallet=m.member_wallet
  WHERE m.fence_id=fid AND(m.original_membership IS DISTINCT FROM to_jsonb(live) OR live.clan_id IS DISTINCT FROM f.clan_id
   OR m.original_membership->>'player_wallet' IS DISTINCT FROM m.member_wallet
   OR(m.eligible AND(m.original_base->>'id' IS DISTINCT FROM m.base_id::text OR m.base_id IS NULL OR m.slot IS NULL OR m.slot<=0
    OR m.original_base->>'owner_wallet' IS DISTINCT FROM m.member_wallet OR m.original_base->>'status' IS DISTINCT FROM 'active'
    OR m.original_base->>'land_paid_at' IS NULL OR m.original_slot->>'base_id' IS DISTINCT FROM m.base_id::text
    OR m.original_slot->>'wallet' IS DISTINCT FROM m.member_wallet OR m.original_slot->>'active' IS DISTINCT FROM 'true'
    OR m.original_slot->>'slot' IS DISTINCT FROM m.slot::text))
   OR(NOT m.eligible AND num_nonnulls(m.base_id,m.slot,m.original_base,m.original_slot)<>0)))
 OR(total>0 AND cardinality(eligible)=0)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 FOR e IN SELECT * FROM public.clan_charter_raid_events WHERE original_clan_id=f.clan_id ORDER BY clan_ordinal LOOP
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

CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_plan(fid uuid,actor text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE f public.clan_charter_member_fences%ROWTYPE;s jsonb;
BEGIN
 PERFORM public.shardkeep_charter_member_payment_owner();
 SELECT * INTO f FROM public.clan_charter_member_fences WHERE id=fid AND actor_wallet=actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_NOT_FOUND';END IF;
 s:=public.shardkeep_charter_member_payment_source(fid);
 RETURN jsonb_build_object('fenceId',f.id,'clanId',f.clan_id,'actorWallet',f.actor_wallet,'totalShards',s->>'totalShards','allocations',s->'allocations');
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_validate(pid uuid,finished boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p public.clan_charter_member_payments%ROWTYPE;t public.clan_charter_member_posts%ROWTYPE;
 x jsonb;expected jsonb;retained jsonb;account public.accounts%ROWTYPE;entry public.ledger_entries%ROWTYPE;
 effect public.clan_charter_member_effects%ROWTYPE;amount bigint;before_amount bigint;aid uuid;count_positive bigint;
 source jsonb;is_current boolean;roster jsonb;identity jsonb;destination jsonb;observation public.deed_ownership_observations%ROWTYPE;
BEGIN
 PERFORM public.shardkeep_charter_member_payment_owner();PERFORM public.shardkeep_charter_member_payment_hooks();
 SELECT * INTO STRICT p FROM public.clan_charter_member_payments WHERE id=pid;
 is_current:=coalesce(p.tx_key=pg_current_xact_id_if_assigned()::text,false);
 source:=public.shardkeep_charter_member_payment_source(p.fence_id,CASE WHEN finished THEN p.source ELSE NULL END);
 IF source IS DISTINCT FROM p.source OR p.total_shards IS DISTINCT FROM(source->>'totalShards')::bigint
 OR p.clan_id::text IS DISTINCT FROM source->'fence'->>'clan_id' OR p.actor_wallet IS DISTINCT FROM source->'fence'->>'actor_wallet'
 OR p.pool_before<p.total_shards OR p.pool_identity->>'id' IS DISTINCT FROM p.pool_account_id::text
 OR p.pool_identity->>'kind' IS DISTINCT FROM 'clan_chest' OR p.pool_identity->>'currency' IS DISTINCT FROM 'SHARDS'
 OR p.pool_identity->>'owner_wallet' IS NOT NULL OR p.pool_identity->>'base_id' IS NOT NULL
 OR jsonb_array_length(p.allocations)<>jsonb_array_length(source->'allocations')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',value->>'wallet','shards',value->>'shards') ORDER BY ord),'[]'::jsonb)
 INTO roster FROM jsonb_array_elements(p.allocations) WITH ORDINALITY v(value,ord);
 IF roster IS DISTINCT FROM source->'allocations' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 SELECT count(*) INTO count_positive FROM jsonb_array_elements(p.allocations) a WHERE(a->>'shards')::bigint>0;
 SELECT * INTO t FROM public.clan_charter_member_posts WHERE payment_id=p.id;
 IF p.total_shards=0 THEN
  IF t.ledger_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.ledger_transactions WHERE idempotency_key='clan-charter:member-payment:'||p.id::text
   OR(type='clan.charter.member_settlement' AND metadata->>'paymentId'=p.id::text))
  OR EXISTS(SELECT 1 FROM public.clan_charter_member_entries WHERE payment_id=p.id)
  OR EXISTS(SELECT 1 FROM public.clan_charter_member_effects WHERE payment_id=p.id)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 ELSE
  IF t.ledger_id IS NULL OR t.tx_key IS DISTINCT FROM p.tx_key
  OR NOT EXISTS(SELECT 1 FROM public.ledger_transactions actual WHERE id=t.ledger_id AND to_jsonb(actual)=t.original_transaction
   AND type='clan.charter.member_settlement' AND idempotency_key='clan-charter:member-payment:'||p.id::text
   AND metadata=jsonb_build_object('paymentId',p.id,'fenceId',p.fence_id,'clanId',p.clan_id,'actorWallet',p.actor_wallet,'totalShards',p.total_shards::text))
  OR(SELECT count(*) FROM public.ledger_transactions WHERE idempotency_key='clan-charter:member-payment:'||p.id::text
   OR(type='clan.charter.member_settlement' AND metadata->>'paymentId'=p.id::text))<>1
  OR(SELECT count(*) FROM public.ledger_entries WHERE txn_id=t.ledger_id)<>count_positive+1
  OR(SELECT count(*) FROM public.clan_charter_member_entries WHERE payment_id=p.id)<>count_positive+1
  OR(SELECT coalesce(sum(delta),0) FROM public.ledger_entries WHERE txn_id=t.ledger_id)<>0
  OR(SELECT count(*) FROM public.clan_charter_member_effects WHERE payment_id=p.id AND kind='accounts')<>count_positive+1
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p.allocations) UNION ALL
  SELECT jsonb_build_object('wallet',NULL,'shards',(-p.total_shards)::text,'baseId',NULL,'accountId',p.pool_account_id,
   'accountIdentity',p.pool_identity,'accountBefore',p.pool_before::text) WHERE p.total_shards>0 LOOP
  amount:=(x->>'shards')::bigint;
  IF amount=0 THEN
   IF x->>'baseId' IS NOT NULL OR x->>'accountId' IS NOT NULL OR x->>'authority' IS NOT NULL
    OR x->>'accountIdentity' IS NOT NULL OR x->>'accountBefore' IS NOT NULL
   THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;CONTINUE;
  END IF;
  aid:=(x->>'accountId')::uuid;before_amount:=(x->>'accountBefore')::bigint;identity:=x->'accountIdentity';
  SELECT * INTO account FROM public.accounts WHERE id=aid;
  SELECT * INTO entry FROM public.ledger_entries WHERE txn_id=t.ledger_id AND account_id=aid;
  SELECT original_entry INTO retained FROM public.clan_charter_member_entries WHERE entry_id=entry.id AND payment_id=p.id
   AND tx_key=p.tx_key AND account_identity=identity;
  SELECT * INTO effect FROM public.clan_charter_member_effects WHERE payment_id=p.id AND kind='accounts' AND target_id=aid;
  IF account.id IS NULL OR to_jsonb(account)-'balance' IS DISTINCT FROM identity
  OR entry.id IS NULL OR entry.delta IS DISTINCT FROM amount OR entry.balance_after IS DISTINCT FROM before_amount+amount
  OR retained IS DISTINCT FROM to_jsonb(entry) OR before_amount IS NULL OR before_amount<0
  OR effect.payment_id IS NULL OR effect.tx_key IS DISTINCT FROM p.tx_key
  OR effect.before_row IS DISTINCT FROM identity||jsonb_build_object('balance',before_amount)
  OR effect.after_row IS DISTINCT FROM identity||jsonb_build_object('balance',before_amount+amount)
  OR(is_current AND account.balance IS DISTINCT FROM before_amount+amount)
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  IF amount>0 THEN
   destination:=x->'authority';observation:=jsonb_populate_record(NULL::public.deed_ownership_observations,destination->'observation');
   IF identity->>'kind' IS DISTINCT FROM 'base_shards' OR identity->>'currency' IS DISTINCT FROM 'SHARDS'
   OR identity->>'base_id' IS DISTINCT FROM x->>'baseId' OR identity->>'owner_wallet' IS NOT NULL
   OR destination->'base'->>'id' IS DISTINCT FROM x->>'baseId' OR destination->'base'->>'owner_wallet' IS DISTINCT FROM x->>'wallet'
   OR destination->'base'->>'status' IS DISTINCT FROM 'active' OR destination->'base'->>'land_paid_at' IS NULL
   OR destination->'base'->>'deed_asset_id' IS NULL OR destination->'slot'->>'base_id' IS DISTINCT FROM x->>'baseId'
   OR destination->'slot'->>'wallet' IS DISTINCT FROM x->>'wallet' OR destination->'slot'->>'active' IS DISTINCT FROM 'true'
   OR observation.base_id::text IS DISTINCT FROM x->>'baseId' OR observation.asset_id IS DISTINCT FROM destination->'base'->>'deed_asset_id'
   OR observation.owner IS DISTINCT FROM x->>'wallet' OR observation.status IS DISTINCT FROM 'owned'
   OR public.shardkeep_charter_custody_proof(observation) IS NOT TRUE OR observation.checked_at>p.paid_at
   OR p.paid_at-observation.checked_at>p.freshness_ms*interval '1 millisecond'
   OR(is_current AND public.shardkeep_charter_member_payment_destination(x->>'wallet',(x->>'baseId')::uuid,p.freshness_ms) IS DISTINCT FROM destination)
   THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_DESTINATION';END IF;
  END IF;
 END LOOP;
 IF p.total_shards>0 THEN
  SELECT * INTO effect FROM public.clan_charter_member_effects WHERE payment_id=p.id AND kind='clans';
  expected:=p.source->'headBefore'->'clan_state';
  IF finished THEN
   IF effect.payment_id IS NULL OR effect.target_id IS DISTINCT FROM p.clan_id OR effect.tx_key IS DISTINCT FROM p.tx_key
    OR effect.before_row IS DISTINCT FROM expected OR effect.after_row IS DISTINCT FROM jsonb_set(expected,'{chest_shards}','0'::jsonb)
    OR(SELECT count(*) FROM public.clan_charter_member_effects WHERE payment_id=p.id AND kind='clans')<>1
   THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
  ELSIF effect.payment_id IS NOT NULL THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 END IF;
 IF is_current AND(SELECT balance FROM public.accounts WHERE id=p.pool_account_id)
  IS DISTINCT FROM(SELECT coalesce(sum(chest_shards),0)-CASE WHEN finished THEN 0 ELSE p.total_shards END FROM public.clans)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_read(fid uuid,actor text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p public.clan_charter_member_payments%ROWTYPE;ledger uuid;
BEGIN
 PERFORM public.shardkeep_charter_member_payment_owner();PERFORM public.shardkeep_charter_member_payment_hooks();
 IF NOT EXISTS(SELECT 1 FROM public.clan_charter_member_fences WHERE id=fid AND actor_wallet=actor)
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_NOT_FOUND';END IF;
 SELECT * INTO p FROM public.clan_charter_member_payments WHERE fence_id=fid;
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM public.shardkeep_charter_member_payment_validate(p.id,true);
 SELECT ledger_id INTO ledger FROM public.clan_charter_member_posts WHERE payment_id=p.id;
 RETURN jsonb_build_object('id',p.id,'fenceId',p.fence_id,'clanId',p.clan_id,'actorWallet',p.actor_wallet,
  'totalShards',p.total_shards::text,'ledgerTransactionId',ledger,
  'paidAt',to_char(p.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'allocations',(SELECT coalesce(jsonb_agg(jsonb_build_object('wallet',value->>'wallet','shards',value->>'shards',
   'baseId',value->'baseId','accountId',value->'accountId','entryId',(SELECT id::text FROM public.ledger_entries
    WHERE txn_id=ledger AND account_id=(value->>'accountId')::uuid)) ORDER BY ord),'[]'::jsonb)
   FROM jsonb_array_elements(p.allocations) WITH ORDINALITY x(value,ord)),
  'signingAuthorized',false,'transferAuthorized',false,'fenceReleaseAuthorized',false);
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE p public.clan_charter_member_payments%ROWTYPE;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass,'public.clans'::regclass)
 OR TG_NAME<>TG_TABLE_NAME||'_charter_member_payment_capture' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
 OR(TG_TABLE_NAME IN('ledger_transactions','ledger_entries') AND TG_OP<>'INSERT')
 OR(TG_TABLE_NAME IN('accounts','clans') AND TG_OP<>'UPDATE') THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_TRIGGER';END IF;
 IF TG_TABLE_NAME='ledger_transactions' THEN
  IF NEW.type='clan.charter.member_settlement' OR NEW.idempotency_key LIKE 'clan-charter:member-payment:%' THEN
   INSERT INTO public.clan_charter_member_posts(ledger_id) VALUES(NEW.id);
  END IF;
 ELSIF TG_TABLE_NAME='ledger_entries' THEN
  SELECT payment.* INTO p FROM public.clan_charter_member_payments payment JOIN public.clan_charter_member_posts post ON post.payment_id=payment.id WHERE post.ledger_id=NEW.txn_id;
  IF FOUND THEN INSERT INTO public.clan_charter_member_entries(entry_id) VALUES(NEW.id);
  ELSIF EXISTS(SELECT 1 FROM public.clan_charter_member_payments payment WHERE payment.tx_key=pg_current_xact_id()::text
   AND(payment.pool_account_id=NEW.account_id OR EXISTS(SELECT 1 FROM jsonb_array_elements(payment.allocations) a WHERE a->>'accountId'=NEW.account_id::text)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 ELSE
  FOR p IN SELECT * FROM public.clan_charter_member_payments payment WHERE payment.tx_key=pg_current_xact_id()::text
   AND((TG_TABLE_NAME='clans' AND payment.clan_id=NEW.id) OR(TG_TABLE_NAME='accounts' AND(payment.pool_account_id=NEW.id
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(payment.allocations) a WHERE a->>'accountId'=NEW.id::text)))) LOOP
   INSERT INTO public.clan_charter_member_effects(payment_id,kind,target_id,tx_key,before_row,after_row)
    VALUES(p.id,TG_TABLE_NAME,NEW.id,p.tx_key,to_jsonb(OLD),to_jsonb(NEW));
  END LOOP;
 END IF;RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE pid uuid;
BEGIN
 IF TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_TRIGGER';END IF;
 IF TG_RELID IN('public.clan_charter_member_payments'::regclass,'public.clan_charter_member_posts'::regclass,
  'public.clan_charter_member_entries'::regclass,'public.clan_charter_member_effects'::regclass) THEN
  IF TG_NAME<>TG_TABLE_NAME||'_complete' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_TRIGGER';END IF;
  pid:=(CASE WHEN TG_TABLE_NAME='clan_charter_member_payments' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'payment_id' END)::uuid;
  PERFORM public.shardkeep_charter_member_payment_validate(pid,true);
 ELSIF TG_RELID IN('public.accounts'::regclass,'public.clans'::regclass,'public.bases'::regclass,
  'public.base_slots'::regclass,'public.deed_ownership_observations'::regclass,'public.base_raid_locks'::regclass,'public.raids'::regclass) THEN
  IF TG_NAME<>TG_TABLE_NAME||'_charter_member_payment_complete' OR TG_OP NOT IN('INSERT','UPDATE','DELETE')
   THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_TRIGGER';END IF;
  -- Ordinary unrelated traffic never enters the private owner/RC boundary.
  -- New source writes recheck even after SET CONSTRAINTS forced an early pass.
  FOR pid IN SELECT id FROM public.clan_charter_member_payments WHERE tx_key=pg_current_xact_id_if_assigned()::text LOOP
   PERFORM public.shardkeep_charter_member_payment_validate(pid,true);
  END LOOP;
 ELSE RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_TRIGGER';END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_protect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE protected boolean;
BEGIN
 IF TG_RELID NOT IN('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass)
 OR TG_NAME<>(TG_TABLE_NAME||CASE WHEN TG_OP='TRUNCATE' THEN '_charter_member_payment_no_truncate' ELSE '_charter_member_payment_protect' END)
 OR TG_WHEN<>'BEFORE' OR(TG_OP='TRUNCATE' AND TG_LEVEL<>'STATEMENT') OR(TG_OP<>'TRUNCATE' AND TG_LEVEL<>'ROW')
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_TRIGGER';END IF;
 IF TG_OP='TRUNCATE' THEN protected:=EXISTS(SELECT 1 FROM public.clan_charter_member_payments);
 ELSIF TG_TABLE_NAME='ledger_transactions' THEN protected:=EXISTS(SELECT 1 FROM public.clan_charter_member_posts WHERE ledger_id=OLD.id)
  OR OLD.type='clan.charter.member_settlement' OR(TG_OP='UPDATE' AND NEW.type='clan.charter.member_settlement');
 ELSIF TG_TABLE_NAME='ledger_entries' THEN protected:=EXISTS(SELECT 1 FROM public.clan_charter_member_posts WHERE ledger_id=OLD.txn_id)
  OR(TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.clan_charter_member_posts WHERE ledger_id=NEW.txn_id));
 ELSE protected:=EXISTS(SELECT 1 FROM public.clan_charter_member_payments p WHERE p.pool_account_id=OLD.id
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.allocations) x WHERE x->>'accountId'=OLD.id::text));
  IF TG_OP='UPDATE' AND to_jsonb(NEW)-'balance'=to_jsonb(OLD)-'balance' THEN protected:=false;END IF;
 END IF;
 IF protected THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_IMMUTABLE';END IF;
 IF TG_OP='TRUNCATE' THEN RETURN NULL;ELSIF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_clan_charter_member_fence_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE affected uuid[];clan uuid;payment public.clan_charter_member_payments%ROWTYPE;
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
  IF EXISTS(SELECT 1 FROM public.clan_charter_member_fences WHERE clan_id=clan) THEN
   SELECT * INTO payment FROM public.clan_charter_member_payments WHERE clan_id=clan;
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
CREATE OR REPLACE FUNCTION public.shardkeep_charter_member_payment_hooks() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE r record;
BEGIN
 IF current_setting('session_replication_role')<>'origin' OR NOT public.shardkeep_clan_charter_raid_chest_hooks()
  OR NOT public.shardkeep_charter_custody_hooks() THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 FOR r IN
  SELECT t.tab,t.tab||x.suffix name,'shardkeep_charter_member_payment_'||x.fn fn,x.typ,false deferred,false definer
   FROM(VALUES('clan_charter_member_payments'),('clan_charter_member_posts'),('clan_charter_member_entries'),('clan_charter_member_effects')) t(tab)
   CROSS JOIN(VALUES('_guard','private',31),('_no_truncate','private',34)) x(suffix,fn,typ)
  UNION ALL SELECT t.tab,t.tab||'_complete','shardkeep_charter_member_payment_complete',5,true,true
   FROM(VALUES('clan_charter_member_payments'),('clan_charter_member_posts'),('clan_charter_member_entries'),('clan_charter_member_effects')) t(tab)
  UNION ALL SELECT t.tab,t.tab||'_charter_member_payment_complete','shardkeep_charter_member_payment_complete',29,true,true
   FROM(VALUES('accounts'),('clans'),('bases'),('base_slots'),('deed_ownership_observations'),('base_raid_locks'),('raids')) t(tab)
  UNION ALL SELECT t.tab,t.tab||'_charter_member_payment_capture','shardkeep_charter_member_payment_capture',t.typ,false,true
   FROM(VALUES('ledger_transactions',5),('ledger_entries',5),('accounts',17),('clans',17)) t(tab,typ)
  UNION ALL SELECT t.tab,t.tab||x.suffix,'shardkeep_charter_member_payment_protect',x.typ,false,true
   FROM(VALUES('ledger_transactions'),('ledger_entries'),('accounts')) t(tab)
   CROSS JOIN(VALUES('_charter_member_payment_protect',27),('_charter_member_payment_no_truncate',34)) x(suffix,typ)
  UNION ALL SELECT t.tab,t.tab||x.suffix,'shardkeep_clan_charter_member_fence_guard',x.typ,false,false
   FROM(VALUES('clan_charter_member_fences'),('clan_charter_member_roster')) t(tab)
   CROSS JOIN(VALUES('_guard',31),('_no_truncate',34)) x(suffix,typ)
  UNION ALL SELECT 'clan_charter_member_fences','clan_charter_member_fences_capture_roster','shardkeep_clan_charter_capture_member_roster',5,false,true
  UNION ALL SELECT t.tab,t.tab||'_charter_member_fence','shardkeep_clan_charter_member_fence_boundary',t.typ,false,true
   FROM(VALUES('clans',27),('clan_members',31),('clan_charter_raid_events',7)) t(tab,typ)
  UNION ALL SELECT t.tab,t.tab||'_charter_member_fence_truncate','shardkeep_clan_charter_member_fence_boundary',34,false,true
   FROM(VALUES('clans'),('clan_members')) t(tab)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger tr JOIN pg_proc fn ON fn.oid=tr.tgfoid JOIN pg_class tab ON tab.oid=tr.tgrelid JOIN pg_namespace ns ON ns.oid=fn.pronamespace
   WHERE tr.tgrelid=('public.'||r.tab)::regclass AND tr.tgname=r.name AND tr.tgtype=r.typ AND tr.tgenabled='O' AND NOT tr.tgisinternal
   AND tr.tgqual IS NULL AND tr.tgnargs=0 AND tr.tgattr=''::int2vector AND ns.nspname='public' AND fn.proname=r.fn
   AND fn.pronargs=0 AND fn.proowner=tab.relowner AND fn.prosecdef=r.definer
   AND tr.tgdeferrable=r.deferred AND tr.tginitdeferred=r.deferred
   AND EXISTS(SELECT 1 FROM unnest(fn.proconfig) v WHERE replace(v,' ','')='search_path=pg_catalog,public,pg_temp')
   AND(NOT r.deferred OR EXISTS(SELECT 1 FROM pg_constraint q WHERE q.oid=tr.tgconstraint AND q.conrelid=tr.tgrelid
    AND q.conname=tr.tgname AND q.contype='t' AND q.condeferrable AND q.condeferred)))
  THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE';END IF;
 END LOOP;
END $$;

--> statement-breakpoint
DO $$DECLARE t text;row record;BEGIN
 IF EXISTS(SELECT 1 FROM public.ledger_transactions actual WHERE(actual.type='clan.charter.member_settlement'
  OR actual.idempotency_key LIKE 'clan-charter:member-payment:%') AND NOT EXISTS(SELECT 1 FROM public.clan_charter_member_posts WHERE ledger_id=actual.id))
 THEN RAISE EXCEPTION 'CLAN_CHARTER_MEMBER_SETTLEMENT_BOOTSTRAP';END IF;
 FOREACH t IN ARRAY ARRAY['clan_charter_member_payments','clan_charter_member_posts','clan_charter_member_entries','clan_charter_member_effects'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_guard') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_member_payment_private()',t||'_guard',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_member_payment_private()',t||'_no_truncate',t);END IF;
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
 END LOOP;
 -- Child/source writes queue completion again if a caller forced earlier
 -- constraints IMMEDIATE, so no trailing posting or ownership change escapes.
 FOREACH t IN ARRAY ARRAY['clan_charter_member_payments','clan_charter_member_posts','clan_charter_member_entries','clan_charter_member_effects'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_member_payment_complete()',t||'_complete',t);END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['accounts','clans','bases','base_slots','deed_ownership_observations','base_raid_locks','raids'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_member_payment_complete') THEN
   EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_member_payment_complete()',t||'_charter_member_payment_complete',t);END IF;
 END LOOP;
 FOR row IN SELECT * FROM(VALUES('ledger_transactions','INSERT'),('ledger_entries','INSERT'),('accounts','UPDATE'),('clans','UPDATE')) x(tab,event) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||row.tab)::regclass AND tgname=row.tab||'_charter_member_payment_capture') THEN
   EXECUTE format('CREATE TRIGGER %I AFTER %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_member_payment_capture()',row.tab||'_charter_member_payment_capture',row.event,row.tab);END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ledger_transactions','ledger_entries','accounts'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_member_payment_protect') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.shardkeep_charter_member_payment_protect()',t||'_charter_member_payment_protect',t);END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname=t||'_charter_member_payment_no_truncate') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_charter_member_payment_protect()',t||'_charter_member_payment_no_truncate',t);END IF;
 END LOOP;
 FOR row IN SELECT p.oid::regprocedure identity FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname LIKE 'shardkeep_charter_member_payment_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',row.identity);
 END LOOP;
 PERFORM public.shardkeep_charter_member_payment_hooks();
END $$;
