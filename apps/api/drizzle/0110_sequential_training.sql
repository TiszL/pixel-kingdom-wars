-- Preserve every old promised timestamp. New writers explicitly use schedule version 2.
ALTER TABLE training_queue ADD COLUMN schedule_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE base_training_queue ADD COLUMN schedule_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE training_queue ADD CONSTRAINT training_queue_schedule_ck CHECK
  (schedule_version IN (1, 2) AND (schedule_version = 1 OR finishes_at > started_at));
--> statement-breakpoint
ALTER TABLE base_training_queue ADD CONSTRAINT base_training_queue_schedule_ck CHECK
  (schedule_version IN (1, 2) AND (schedule_version = 1 OR finishes_at > started_at));
