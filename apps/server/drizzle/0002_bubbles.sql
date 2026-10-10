CREATE TABLE `bubble_inbox` (
	`message_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`handled` integer NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bubble_inbox_user_idx` ON `bubble_inbox` (`user_id`);--> statement-breakpoint
CREATE TABLE `bubble_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`onboarding_step` text,
	`onboarding_started_at` text,
	`onboarding_completed_at` text,
	`pending` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `crew_invites` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`status` text NOT NULL,
	`sent_at` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `google_tokens` (
	`user_id` text PRIMARY KEY NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expiry_date` integer,
	`scope` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
