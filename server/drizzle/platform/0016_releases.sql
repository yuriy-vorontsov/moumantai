CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` text NOT NULL,
	`content_hash` text NOT NULL,
	`schema_tag` text,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`draft_id` text,
	`approval_id` text,
	`validation_run_id` text,
	`artifact_dir` text NOT NULL,
	`migration_plan` text,
	`db_backup` text,
	`created_at` text NOT NULL,
	`activated_at` text
);
--> statement-breakpoint
CREATE INDEX `releases_app_idx` ON `releases` (`app_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `validation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`app_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`ok` integer NOT NULL,
	`steps` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `validation_runs_draft_idx` ON `validation_runs` (`draft_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`target` text NOT NULL,
	`content_hash` text,
	`decision` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lifecycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`app_id` text NOT NULL,
	`state` text NOT NULL,
	`actor` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lifecycle_events_subject_idx` ON `lifecycle_events` (`subject_type`,`subject_id`);
