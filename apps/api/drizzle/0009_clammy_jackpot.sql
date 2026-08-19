CREATE TABLE `agent_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`system_prompt` text NOT NULL,
	`model_id` text NOT NULL,
	`token_digest` text NOT NULL,
	`token_hint` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_definitions_token` ON `agent_definitions` (`token_digest`);--> statement-breakpoint
CREATE INDEX `idx_agent_definitions_workspace` ON `agent_definitions` (`workspace_id`,`created_at`);
