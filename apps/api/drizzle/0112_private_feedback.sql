-- Additive private-feedback foundation; no historical points/notes/IDs are rewritten.
ALTER TABLE tester_feedback ADD COLUMN reward_policy_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE tester_feedback ALTER COLUMN reward_policy_version SET DEFAULT 2;
--> statement-breakpoint
ALTER TABLE tester_feedback ADD COLUMN revision integer NOT NULL DEFAULT 1, ADD COLUMN reporter_revision integer NOT NULL DEFAULT 1,
 ADD COLUMN locked_at timestamptz, ADD COLUMN closed_at timestamptz,
 ADD CONSTRAINT tester_feedback_revision_ck CHECK (revision >= reporter_revision AND reporter_revision > 0 AND reward_policy_version IN (1, 2));
--> statement-breakpoint
CREATE TABLE feedback_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES tester_feedback(id),
  author text NOT NULL,
  visibility text NOT NULL,
  kind text NOT NULL,
  body text ,
  context jsonb ,
  revision integer NOT NULL,
  reporter_revision integer,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT feedback_messages_report_id_uq UNIQUE (report_id, id),
CONSTRAINT feedback_messages_revision_uq UNIQUE (report_id, revision),
CONSTRAINT feedback_messages_request_uq UNIQUE (author, request_id),
CONSTRAINT feedback_messages_visibility_ck CHECK (visibility IN ('reporter', 'admin')),
CONSTRAINT feedback_messages_kind_ck CHECK (kind IN ('reply', 'status', 'note')),
CONSTRAINT feedback_messages_revision_ck CHECK (revision > 0)
);
--> statement-breakpoint
CREATE TABLE feedback_readers (
  report_id uuid NOT NULL REFERENCES tester_feedback(id),
  reader text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  read_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT feedback_readers_reader_uq UNIQUE (report_id, reader),
CONSTRAINT feedback_readers_revision_ck CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE TABLE feedback_attachments (
  upload_role text NOT NULL DEFAULT 'reporter',
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text NOT NULL REFERENCES players(wallet),
  report_id uuid REFERENCES tester_feedback(id),
  message_id uuid ,
  request_id text NOT NULL,
  state text NOT NULL DEFAULT 'uploading',
  object_key text ,
  sha256 text ,
  byte_length integer ,
  width integer ,
  height integer ,
  content_type text ,
  expires_at timestamptz NOT NULL,
  preserved_at timestamptz ,
  preserved_by text ,
  preservation_reason text ,
  delete_after timestamptz ,
  deleted_at timestamptz ,
  delete_attempts integer NOT NULL DEFAULT 0,
  last_error_code text ,
  created_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT feedback_attachments_upload_role_ck CHECK (upload_role IN ('reporter', 'admin')),
CONSTRAINT feedback_attachments_request_uq UNIQUE (wallet, request_id),
CONSTRAINT feedback_attachments_object_uq UNIQUE (object_key),
CONSTRAINT feedback_attachments_state_ck CHECK (state IN ('uploading', 'stored', 'attached', 'deleting', 'deleted', 'failed')),
CONSTRAINT feedback_attachments_message_fk FOREIGN KEY (report_id, message_id) REFERENCES feedback_messages(report_id, id),
CONSTRAINT feedback_attachments_message_ck CHECK (message_id IS NULL OR report_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX feedback_attachments_report_idx ON feedback_attachments (report_id);
--> statement-breakpoint
CREATE INDEX feedback_attachments_expiry_idx ON feedback_attachments (state, expires_at);
--> statement-breakpoint
CREATE TABLE feedback_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  revision integer NOT NULL DEFAULT 1,
  approved_by text NOT NULL,
  published_at timestamptz ,
  merged_into uuid ,
  recurrence_of uuid ,
  created_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT feedback_issues_status_ck CHECK (status IN ('open', 'investigating', 'planned', 'fixed', 'closed', 'merged'))
);
--> statement-breakpoint
CREATE INDEX feedback_issues_public_idx ON feedback_issues (published_at, status);
--> statement-breakpoint
CREATE TABLE feedback_issue_links (
  report_id uuid NOT NULL REFERENCES tester_feedback(id),
  issue_id uuid NOT NULL REFERENCES feedback_issues(id),
  linked_by text NOT NULL,
  reason text ,
  created_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT feedback_issue_links_report_uq UNIQUE (report_id)
);
--> statement-breakpoint
CREATE INDEX feedback_issue_links_issue_idx ON feedback_issue_links (issue_id);
--> statement-breakpoint
CREATE TABLE feedback_confirmations (
  issue_id uuid NOT NULL REFERENCES feedback_issues(id),
  wallet text NOT NULL REFERENCES players(wallet),
  created_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT feedback_confirmations_wallet_uq UNIQUE (issue_id, wallet)
);
--> statement-breakpoint
CREATE TABLE feedback_reward_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES tester_feedback(id),
  wallet text NOT NULL REFERENCES players(wallet),
  admin text NOT NULL,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  policy_version integer NOT NULL,
  report_revision integer NOT NULL,
  reason text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT feedback_reward_decisions_request_uq UNIQUE (admin, request_id)
);
--> statement-breakpoint
CREATE INDEX feedback_reward_decisions_wallet_idx ON feedback_reward_decisions (wallet, created_at);
--> statement-breakpoint
CREATE TABLE feedback_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by text NOT NULL,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  format text NOT NULL,
  schema_version integer NOT NULL,
  selection jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  object_key text ,
  sha256 text ,
  manifest jsonb ,
  error_code text ,
  expires_at timestamptz NOT NULL,
  prepared_at timestamptz ,
  download_requested_at timestamptz ,
  delete_after timestamptz ,
  deleted_at timestamptz ,
  delete_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
CONSTRAINT feedback_export_jobs_request_uq UNIQUE (requested_by, request_id),
CONSTRAINT feedback_export_jobs_object_uq UNIQUE (object_key),
CONSTRAINT feedback_export_jobs_format_ck CHECK (format IN ('text', 'json', 'zip')),
CONSTRAINT feedback_export_jobs_state_ck CHECK (state IN ('pending', 'preparing', 'ready', 'failed', 'deleting', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX feedback_export_jobs_expiry_idx ON feedback_export_jobs (state, expires_at);
--> statement-breakpoint
CREATE TABLE feedback_export_reports (
  job_id uuid NOT NULL REFERENCES feedback_export_jobs(id),
  report_id uuid NOT NULL REFERENCES tester_feedback(id),
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  sha256 text NOT NULL,
CONSTRAINT feedback_export_reports_job_uq UNIQUE (job_id, report_id)
);
--> statement-breakpoint
ALTER TABLE feedback_messages ADD CONSTRAINT feedback_messages_note_private_ck CHECK (kind <> 'note' OR visibility = 'admin');
--> statement-breakpoint
ALTER TABLE feedback_issues ADD CONSTRAINT feedback_issues_links_ck CHECK (revision > 0 AND (merged_into IS NULL OR merged_into <> id) AND (recurrence_of IS NULL OR recurrence_of <> id) AND ((status = 'merged') = (merged_into IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE feedback_attachments ADD CONSTRAINT feedback_attachments_complete_ck CHECK ((state <> 'attached' OR report_id IS NOT NULL) AND (state NOT IN ('stored', 'attached') OR (object_key IS NOT NULL AND sha256 IS NOT NULL AND sha256 ~ '^[0-9a-f]{64}$' AND byte_length IS NOT NULL AND byte_length > 0 AND width IS NOT NULL AND width > 0 AND height IS NOT NULL AND height > 0 AND content_type IS NOT NULL AND content_type = 'image/webp')) AND delete_attempts >= 0);
--> statement-breakpoint
ALTER TABLE feedback_attachments ADD CONSTRAINT feedback_attachments_preserve_ck CHECK ((preserved_at IS NULL AND preserved_by IS NULL AND preservation_reason IS NULL) OR (preserved_at IS NOT NULL AND preserved_by IS NOT NULL AND preservation_reason IS NOT NULL));
--> statement-breakpoint
ALTER TABLE feedback_reward_decisions ADD CONSTRAINT feedback_reward_decisions_policy_ck CHECK (policy_version IN (1, 2) AND report_revision > 0);
--> statement-breakpoint
ALTER TABLE feedback_export_jobs ADD CONSTRAINT feedback_export_jobs_version_ck CHECK (schema_version > 0 AND delete_attempts >= 0);
--> statement-breakpoint
ALTER TABLE feedback_export_reports ADD CONSTRAINT feedback_export_reports_revision_ck CHECK (revision > 0);
--> statement-breakpoint
ALTER TABLE feedback_issues ADD CONSTRAINT feedback_issues_merged_into_feedback_issues_id_fk FOREIGN KEY (merged_into) REFERENCES feedback_issues(id), ADD CONSTRAINT feedback_issues_recurrence_of_feedback_issues_id_fk FOREIGN KEY (recurrence_of) REFERENCES feedback_issues(id);
--> statement-breakpoint
ALTER TABLE feedback_messages ADD CONSTRAINT feedback_messages_reporter_revision_uq UNIQUE (report_id, reporter_revision),
 ADD CONSTRAINT feedback_messages_reporter_revision_ck CHECK ((visibility = 'reporter' AND reporter_revision IS NOT NULL AND reporter_revision > 1 AND reporter_revision <= revision) OR (visibility = 'admin' AND reporter_revision IS NULL));
--> statement-breakpoint
ALTER TABLE tester_feedback ADD COLUMN request_id text, ADD COLUMN request_hash text, ADD COLUMN submission_receipt jsonb,
 ADD CONSTRAINT tester_feedback_request_uq UNIQUE (wallet, request_id),
 ADD CONSTRAINT tester_feedback_request_ck CHECK ((request_id IS NULL AND request_hash IS NULL AND submission_receipt IS NULL) OR (request_id IS NOT NULL AND request_hash IS NOT NULL AND submission_receipt IS NOT NULL));
--> statement-breakpoint
ALTER TABLE feedback_issues ADD COLUMN category text NOT NULL DEFAULT 'other', ADD COLUMN workaround text, ADD COLUMN fixed_release text;
--> statement-breakpoint
CREATE TABLE feedback_issue_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 admin text NOT NULL,
 request_id text NOT NULL,
 request_hash text NOT NULL,
 action text NOT NULL,
 reason text NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT feedback_issue_actions_request_uq UNIQUE(admin, request_id),
 CONSTRAINT feedback_issue_actions_action_ck CHECK(action IN ('create', 'update', 'publish', 'link', 'merge', 'split', 'reopen'))
);
--> statement-breakpoint
CREATE TABLE feedback_evidence_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 wallet text NOT NULL REFERENCES players(wallet),
 request_id text NOT NULL,
 request_hash text NOT NULL,
 issue_id uuid NOT NULL REFERENCES feedback_issues(id),
 report_id uuid NOT NULL REFERENCES tester_feedback(id),
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT feedback_evidence_requests_request_uq UNIQUE(wallet,request_id)
);

--> statement-breakpoint
ALTER TABLE feedback_export_jobs ADD COLUMN preparation_generation uuid,
 ADD COLUMN preparation_lease_until timestamptz,
 ADD COLUMN preparation_attempts integer NOT NULL DEFAULT 0,
 ADD CONSTRAINT feedback_export_jobs_preparation_attempts_ck CHECK(preparation_attempts >= 0);
