CREATE TABLE `transcriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`title` text NOT NULL,
	`bytes` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`model` text,
	`error` text,
	`document_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_transcriptions_workspace` ON `transcriptions` (`workspace_id`,`created_at`);