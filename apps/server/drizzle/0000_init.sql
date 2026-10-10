CREATE TABLE `asks` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`concession` text,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`sent_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asks_idempotency_key_unique` ON `asks` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `asks_plan_status_idx` ON `asks` (`plan_id`,`status`);--> statement-breakpoint
CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` text,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_plan_idx` ON `audit` (`plan_id`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`venue_id` text NOT NULL,
	`backup_venue_id` text,
	`status` text NOT NULL,
	`party_size` integer NOT NULL,
	`start_at` text NOT NULL,
	`reservation_name` text NOT NULL,
	`confirmation_code` text,
	`call_id` text,
	`deposit_requested` integer DEFAULT false NOT NULL,
	`notes` text,
	`idempotency_key` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_idempotency_key_unique` ON `bookings` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `bookings_plan_idx` ON `bookings` (`plan_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`at` text NOT NULL,
	`payload` text NOT NULL,
	`inserted_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_plan_seq_idx` ON `events` (`plan_id`,`seq`);--> statement-breakpoint
CREATE TABLE `facts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`hard` integer NOT NULL,
	`confidence` real NOT NULL,
	`source` text NOT NULL,
	`confirmed` integer NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `facts_user_idx` ON `facts` (`user_id`);--> statement-breakpoint
CREATE TABLE `group_members` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`chat_id` text NOT NULL,
	`center_lat` real,
	`center_lng` real,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_chat_id_unique` ON `groups` (`chat_id`);--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` real NOT NULL,
	`note` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ledger_group_user_idx` ON `ledger` (`group_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `plan_members` (
	`plan_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`represented_by_bubble` integer DEFAULT false NOT NULL,
	`joined_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`plan_id`, `user_id`),
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`state` text NOT NULL,
	`resume_state` text,
	`intent` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`source_message_id` text,
	`page_token` text NOT NULL,
	`page_token_expires_at` text,
	`chosen_venue_id` text,
	`backup_venue_id` text,
	`start_at` text,
	`locked_at` text,
	`message_budget` integer NOT NULL,
	`messages_used` integer DEFAULT 0 NOT NULL,
	`demo_mode` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_page_token_unique` ON `plans` (`page_token`);--> statement-breakpoint
CREATE INDEX `plans_chat_state_idx` ON `plans` (`chat_id`,`state`);--> statement-breakpoint
CREATE TABLE `timers` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`kind` text NOT NULL,
	`fire_at` integer NOT NULL,
	`payload` text NOT NULL,
	`fired_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `timers_due_idx` ON `timers` (`fired_at`,`fire_at`);--> statement-breakpoint
CREATE INDEX `timers_plan_idx` ON `timers` (`plan_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`handle` text NOT NULL,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique` ON `users` (`handle`);--> statement-breakpoint
CREATE TABLE `venues` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cuisine` text NOT NULL,
	`diet_tags` text NOT NULL,
	`accessibility_tags` text NOT NULL,
	`price_level` integer NOT NULL,
	`typical_cost_usd` integer NOT NULL,
	`hours` text NOT NULL,
	`phone` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`address` text,
	`neighborhood` text,
	`is_demo` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `votes` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`poll_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`choice` text NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `votes_poll_user_choice_idx` ON `votes` (`poll_id`,`user_id`,`choice`);--> statement-breakpoint
CREATE INDEX `votes_plan_idx` ON `votes` (`plan_id`);