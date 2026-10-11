-- Owner2026-09-07: reversible admin trash, preserving existing rewards/history.
ALTER TABLE tester_feedback ADD COLUMN trashed_at timestamptz;
--> statement-breakpoint
ALTER TABLE tester_feedback ADD COLUMN trashed_by text;
--> statement-breakpoint
ALTER TABLE tester_feedback ADD COLUMN trash_reason text;
--> statement-breakpoint
ALTER TABLE tester_feedback ADD CONSTRAINT tester_feedback_trash_ck CHECK (
  (trashed_at IS NULL AND trashed_by IS NULL AND trash_reason IS NULL) OR
  (trashed_at IS NOT NULL AND trashed_by IS NOT NULL AND trash_reason IS NOT NULL AND length(btrim(trash_reason)) > 0)
);
