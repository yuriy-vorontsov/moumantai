ALTER TABLE `devices` ADD `role` text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
UPDATE `devices` SET `role` = 'owner' WHERE `paired` = 1;
--> statement-breakpoint
CREATE TABLE `change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`app_id` text NOT NULL,
	`request` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`draft_id` text,
	`origin_device_id` text,
	`conversation_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `change_requests_app_status_idx` ON `change_requests` (`app_id`,`status`);
