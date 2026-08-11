CREATE TABLE `playbook_bullets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`fingerprint` text NOT NULL,
	`helpful` integer DEFAULT 0 NOT NULL,
	`harmful` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`run_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_playbook_workspace` ON `playbook_bullets` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_playbook_fingerprint` ON `playbook_bullets` (`workspace_id`,`fingerprint`);