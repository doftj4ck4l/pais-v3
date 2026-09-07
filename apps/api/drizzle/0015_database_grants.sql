CREATE TABLE `database_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`granted_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `db_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_database_grants_organization` ON `database_grants` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_database_grants_connection` ON `database_grants` (`connection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_database_grants_org_connection` ON `database_grants` (`organization_id`,`connection_id`);--> statement-breakpoint
ALTER TABLE `organization_invitations` ADD `role` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_memberships` ADD `role` text DEFAULT 'member' NOT NULL;