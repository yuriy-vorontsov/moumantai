CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`app_id` text NOT NULL,
	`scope` text NOT NULL,
	`conversation_id` text NOT NULL,
	`principal` text NOT NULL,
	`request_id` text NOT NULL,
	`root_request_id` text NOT NULL,
	`message_id` text,
	`retry_of` text,
	`sdk_session_id` text,
	`state` text NOT NULL,
	`summary` text NOT NULL,
	`progress` text,
	`error_code` text,
	`error_message` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`cancel_requested_at` text,
	`result_ref` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_state_idx` ON `jobs` (`state`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `jobs_conversation_idx` ON `jobs` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `job_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_events_job_idx` ON `job_events` (`job_id`,`seq`);
--> statement-breakpoint
CREATE TABLE `tool_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`app_id` text NOT NULL,
	`tool` text NOT NULL,
	`risk` text NOT NULL,
	`input_hash` text NOT NULL,
	`idempotency_key` text,
	`outcome` text NOT NULL,
	`result` text,
	`created_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `tool_invocations_job_idx` ON `tool_invocations` (`job_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `tool_invocations_key_idx` ON `tool_invocations` (`idempotency_key`);
--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`app_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`input_hash` text NOT NULL,
	`summary` text NOT NULL,
	`risk` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`result` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `approval_requests_job_idx` ON `approval_requests` (`job_id`);
--> statement-breakpoint
CREATE INDEX `approval_requests_status_idx` ON `approval_requests` (`status`,`created_at`);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `sdk_resume_at` text;
