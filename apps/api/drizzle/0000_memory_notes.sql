CREATE TABLE `memory_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ts` integer NOT NULL,
	`content` text NOT NULL,
	`tags` text,
	`source` text
);
