ALTER TABLE `group_members` ADD `confirmed_at` text;--> statement-breakpoint
ALTER TABLE `groups` ADD `status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `groups` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `plan_members` ADD `messages_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `email` text;--> statement-breakpoint
ALTER TABLE `users` ADD `bubble_number` text;--> statement-breakpoint
ALTER TABLE `users` ADD `onboarded_at` text;