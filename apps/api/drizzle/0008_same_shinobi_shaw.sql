CREATE INDEX `idx_runs_started` ON `runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_conversations_created` ON `conversations` (`created_at`);--> statement-breakpoint
UPDATE `runs`
SET `tokens_in` = COALESCE((
	SELECT sum(
		CASE WHEN json_valid(`traces`.`fields`) THEN
			CASE WHEN json_type(`traces`.`fields`, '$.used') IN ('integer', 'real') THEN
				CAST(json_extract(`traces`.`fields`, '$.used') AS INTEGER)
			END
		END
	)
	FROM `traces`
	WHERE `traces`.`run_id` = `runs`.`id`
		AND `traces`.`step` = 'context.usage'
), `runs`.`tokens_in`);
