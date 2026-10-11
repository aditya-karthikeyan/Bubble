ALTER TABLE `groups` ADD `join_code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `groups_join_code_unique` ON `groups` (`join_code`);