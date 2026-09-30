ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk";--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
