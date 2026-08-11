-- Baseline: the schema as it stood when migrations were adopted.
--
-- Every statement is guarded with IF NOT EXISTS, which is how an existing
-- database adopts this file. Databases created before migrations already have
-- these tables and no __drizzle_migrations to say so, so migrate() runs 0000
-- against them once; guarded, that is a no-op that records the baseline
-- instead of failing on the first CREATE TABLE.
--
-- Later migrations are generated normally and need no such guard.

CREATE TABLE IF NOT EXISTS `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`workspace_id` text,
	`seq` integer NOT NULL,
	`page` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chunks_document` ON `chunks` (`document_id`,`seq`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chunks_workspace` ON `chunks` (`workspace_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`kind` text NOT NULL,
	`account_email` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`error` text,
	`tokens_enc` text NOT NULL,
	`cursor` text,
	`last_sync_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_connectors_workspace` ON `connectors` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`title` text NOT NULL,
	`model_id` text NOT NULL,
	`harness_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversations_workspace` ON `conversations` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `db_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`table_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`workspace_id` text,
	`seq` integer NOT NULL,
	`name` text NOT NULL,
	`data_type` text NOT NULL,
	`nullable` integer NOT NULL,
	`is_primary_key` integer NOT NULL,
	`fk_table` text,
	`fk_column` text,
	`comment` text,
	FOREIGN KEY (`table_id`) REFERENCES `db_tables`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_db_columns_table` ON `db_columns` (`table_id`,`seq`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `db_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`name` text NOT NULL,
	`engine` text DEFAULT 'postgres' NOT NULL,
	`secret` text NOT NULL,
	`display_host` text NOT NULL,
	`display_database` text NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`error` text,
	`table_count` integer DEFAULT 0 NOT NULL,
	`last_introspected_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_db_connections_workspace` ON `db_connections` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_db_connections_workspace_name` ON `db_connections` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `db_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`workspace_id` text,
	`schema_name` text NOT NULL,
	`name` text NOT NULL,
	`comment` text,
	`row_estimate` integer DEFAULT 0 NOT NULL,
	`column_count` integer DEFAULT 0 NOT NULL,
	`indexes` text,
	FOREIGN KEY (`connection_id`) REFERENCES `db_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_db_tables_connection` ON `db_tables` (`connection_id`,`schema_name`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`title` text NOT NULL,
	`bytes` integer NOT NULL,
	`pages` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`status` text DEFAULT 'indexed' NOT NULL,
	`error` text,
	`connector_id` text,
	`external_id` text,
	`external_version` text,
	`external_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_documents_workspace` ON `documents` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_documents_external` ON `documents` (`connector_id`,`external_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `generated_images` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text,
	`prompt` text NOT NULL,
	`model` text NOT NULL,
	`storage_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`cost_micros` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_generated_images_workspace` ON `generated_images` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`workspace_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`schema_json` text,
	`uri` text,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_capabilities_server` ON `mcp_capabilities` (`server_id`,`kind`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`url` text,
	`headers_enc` text,
	`command` text,
	`args_json` text,
	`env_enc` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`error` text,
	`error_detail` text,
	`tool_count` integer DEFAULT 0 NOT NULL,
	`last_probed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_servers_workspace` ON `mcp_servers` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_mcp_servers_workspace_name` ON `mcp_servers` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `memory_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`ts` integer NOT NULL,
	`content` text NOT NULL,
	`tags` text,
	`source` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_memory_workspace_ts` ON `memory_notes` (`workspace_id`,`ts`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`seq` integer NOT NULL,
	`text` text,
	`ts` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_conversation` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`workspace_id` text,
	`harness_id` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`tool_errors` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_workspace` ON `runs` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_conversation` ON `runs` (`conversation_id`,`started_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sandboxes` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`container_id` text,
	`workspace_path` text NOT NULL,
	`image` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sandboxes_last_used` ON `sandboxes` (`last_used_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `traces` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text,
	`step` text NOT NULL,
	`fields` text,
	`ts` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_traces_conversation` ON `traces` (`conversation_id`,`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_traces_run` ON `traces` (`run_id`,`ts`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workspaces_user` ON `workspaces` (`user_id`,`created_at`);