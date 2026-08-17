PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_db_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`name` text NOT NULL,
	`engine` text DEFAULT 'postgresql' NOT NULL,
	`secret` text NOT NULL,
	`display_host` text NOT NULL,
	`port` integer DEFAULT 5432 NOT NULL,
	`display_database` text NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`ssl_mode` text DEFAULT 'disable' NOT NULL,
	`has_custom_ca` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`error` text,
	`table_count` integer DEFAULT 0 NOT NULL,
	`last_introspected_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_db_connections`("id", "workspace_id", "name", "engine", "secret", "display_host", "port", "display_database", "username", "ssl_mode", "has_custom_ca", "status", "error", "table_count", "last_introspected_at", "created_at") SELECT "id", "workspace_id", "name", CASE WHEN "engine" = 'postgres' THEN 'postgresql' ELSE "engine" END, "secret", "display_host", 5432, "display_database", '', 'disable', 0, "status", "error", "table_count", "last_introspected_at", "created_at" FROM `db_connections`;--> statement-breakpoint
DROP TABLE `db_connections`;--> statement-breakpoint
ALTER TABLE `__new_db_connections` RENAME TO `db_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_db_connections_workspace` ON `db_connections` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_db_connections_workspace_name` ON `db_connections` (`workspace_id`,`name`);
