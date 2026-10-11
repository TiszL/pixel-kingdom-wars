-- Owner correction 2026-09-08: actual game minters, separate internal identities,
-- and auditable supersession of the collection-only v1 draft snapshot.
CREATE TABLE playtest_internal_wallets (
 wallet text PRIMARY KEY, reason text NOT NULL, recorded_by text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(), evidence jsonb NOT NULL
);
--> statement-breakpoint
-- Exact identities verified against full authenticated sessions and immutable
-- original-mint evidence. Names are provenance, never a runtime blacklist.
INSERT INTO playtest_internal_wallets(wallet,reason,recorded_by,evidence) VALUES
('GbqJJ5DGdk8iyHG9oq1nCQFqcj2kUP1oJVS1aYd1Ln1h','Owner-confirmed team wallet; excluded from campaign prizes and public rankings','owner:2026-09-08','{"displayNameAtVerification":"Gokhan","fullSession":true,"originalMintAsset":"4HZXswweJwwatYkkrHxsfRpTgVDQJkDcYSyNUyNAJtBr","originalMintSignature":"3AN6P6FFW8i9qnNFc8YSTbmcKf4s4KgF17QFwrvZDxL4jzMwjT1AyqTq2wd7vyzs5U79u8Di6F1KTJqNTEvWd3qB","originalMintSlot":"485720015","verifiedAt":"2026-09-08T07:28:37.692051+00:00","ownerDecision":"2026-09-08: admins, Tisz, Torqueond and Gokhan give spots to real players; exclude from public rankings"}'::jsonb),
('DiLk47iqcPziGck8W4R5biWnPiWDVXGqYQ8ZL89ijFYA','Owner-confirmed team wallet; excluded from campaign prizes and public rankings','owner:2026-09-08','{"displayNameAtVerification":"Tisz","fullSession":true,"originalMintAsset":"Eg1atVfpc7v2N999ii8bAnJYbddc6RzYfvtSsLcy8NHs","originalMintSignature":"RpJXUDcQiMqdUfrdV3bBcRManQLncqC5tEh5Csn3wjwUnPYQ6A4yyiCgY9FDao4CA7xNqcvzaUo5mYXS4dftVm6","originalMintSlot":"482962020","verifiedAt":"2026-09-08T07:28:37.692051+00:00","ownerDecision":"2026-09-08: admins, Tisz, Torqueond and Gokhan give spots to real players; exclude from public rankings"}'::jsonb),
('BEdRF1VEch2SoQjuRT8qZh6NUCBeAfJvUcMQgFkNHFB3','Owner-confirmed team wallet; excluded from campaign prizes and public rankings','owner:2026-09-08','{"displayNameAtVerification":"Torqueond","fullSession":true,"originalMintAsset":"hY1fux7LLihHH2TgTQ7MRybUAtHYxq1jWSSg9oksuRd","originalMintSignature":"4WNaAnB7YAXgZpcrJXVwengk3L2QiK3fWo16tcEsWHdQnsi4PAmwUQXL8ehyAoGwjnaLjmBCri3fU1aUi2QFr1G2","originalMintSlot":"479081060","verifiedAt":"2026-09-08T07:28:37.692051+00:00","ownerDecision":"2026-09-08: admins, Tisz, Torqueond and Gokhan give spots to real players; exclude from public rankings"}'::jsonb)
ON CONFLICT(wallet) DO NOTHING;
--> statement-breakpoint
DO $$
DECLARE c record; previous_founders jsonb; detail jsonb; repaired_at timestamptz;
BEGIN
 SELECT * INTO c FROM playtest_campaigns WHERE kind='founding' FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('playtest-mint-inventory',0));
 IF EXISTS(SELECT 1 FROM playtest_campaign_audit WHERE campaign_id=c.id
   AND request_id='system:founder-snapshot-v1-superseded-v2') THEN RETURN; END IF;
 IF c.snapshot_at IS NULL THEN
   IF EXISTS(SELECT 1 FROM playtest_founders) THEN
     RAISE EXCEPTION 'Founding has orphaned founder rows; manual snapshot review required';
   END IF;
   RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM playtest_campaign_audit WHERE campaign_id=c.id
   AND request_id='system:founder-snapshot-v1' AND action='founder-snapshot') THEN
   RAISE EXCEPTION 'Founding snapshot provenance is unknown; manual review required';
 END IF;
 IF c.start_at IS NOT NULL OR c.end_at IS NOT NULL OR c.finalized_at IS NOT NULL OR c.cancelled_at IS NOT NULL
   OR EXISTS(SELECT 1 FROM playtest_awards WHERE campaign_id=c.id) THEN
   RAISE EXCEPTION 'Founding is no longer an unscheduled draft; v1 snapshot supersession requires explicit review';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM playtest_founders)
   OR EXISTS(SELECT 1 FROM playtest_founders WHERE snapshot_at<>c.snapshot_at) THEN
   RAISE EXCEPTION 'Founding snapshot rows disagree with campaign; manual review required';
 END IF;
 SELECT jsonb_agg(to_jsonb(f) ORDER BY position) INTO previous_founders FROM playtest_founders f;
 repaired_at:=clock_timestamp();
 detail:=jsonb_build_object('action','founder-snapshot-superseded','policy','authenticated-game-originals-v2',
   'reason','Owner correction: collection-only original mints included wallets outside authenticated gameplay; team wallets give up spots.',
   'previousCampaign',to_jsonb(c),'previousFounders',previous_founders,
   'supersedesRequestId','system:founder-snapshot-v1');
 INSERT INTO playtest_campaign_audit(campaign_id,request_id,actor,action,request_hash,revision,detail,result,created_at)
 VALUES(c.id,'system:founder-snapshot-v1-superseded-v2','owner:2026-09-08','founder-snapshot-superseded',
   encode(sha256(convert_to(detail::text,'UTF8')),'hex'),c.revision+1,detail,
   jsonb_build_object('snapshotAt',NULL,'revision',c.revision+1,'policy','authenticated-game-originals-v2'),repaired_at);
 -- Only the active projection changes. The exact v1 rows and original audit
 -- receipt above remain immutable evidence; no mint proof is deleted.
 DELETE FROM playtest_founders;
 UPDATE playtest_campaigns SET snapshot_at=NULL,revision=c.revision+1 WHERE id=c.id;
END $$;
