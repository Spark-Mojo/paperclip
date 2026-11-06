ALTER TABLE "issues" ADD COLUMN "monitor_phase_history" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "monitor_active_phase" jsonb;
