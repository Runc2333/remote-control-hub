CREATE TABLE `audit_events` (
	`id` varchar(36) NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`actor_type` varchar(32) NOT NULL,
	`actor_id` varchar(64),
	`subject_type` varchar(64) NOT NULL,
	`subject_id` varchar(64) NOT NULL,
	`owner_user_id` varchar(36),
	`action` varchar(128) NOT NULL,
	`result` varchar(64) NOT NULL,
	`error_category` varchar(64),
	`request_id` varchar(128) NOT NULL,
	`source_address_class` varchar(32) NOT NULL,
	`change_digest` varbinary(32),
	`visibility` enum('owner','admin','system') NOT NULL,
	`metadata` json NOT NULL,
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `command_batches` (
	`id` varchar(36) NOT NULL,
	`owner_user_id` varchar(36) NOT NULL,
	`initiated_by_user_id` varchar(36) NOT NULL,
	`command_type` varchar(64) NOT NULL,
	`target_count` int unsigned NOT NULL,
	`status` enum('created','sent','accepted','executing','succeeded','failed','expired','outcome_unknown') NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`request_digest` varbinary(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `command_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `command_batches_owner_idempotency_unique` UNIQUE(`owner_user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `command_results` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`command_id` varchar(36) NOT NULL,
	`status` enum('created','sent','accepted','executing','succeeded','failed','expired','outcome_unknown') NOT NULL,
	`error_code` varchar(128),
	`received_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	CONSTRAINT `command_results_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `commands` (
	`id` varchar(36) NOT NULL,
	`batch_id` varchar(36) NOT NULL,
	`owner_user_id` varchar(36) NOT NULL,
	`device_id` varchar(36) NOT NULL,
	`status` enum('created','sent','accepted','executing','succeeded','failed','expired','outcome_unknown') NOT NULL,
	`device_sequence` bigint unsigned NOT NULL,
	`parameters` json NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `commands_id` PRIMARY KEY(`id`),
	CONSTRAINT `commands_batch_device_unique` UNIQUE(`batch_id`,`device_id`),
	CONSTRAINT `commands_device_sequence_unique` UNIQUE(`device_id`,`device_sequence`)
);
--> statement-breakpoint
CREATE TABLE `device_group_members` (
	`group_id` varchar(36) NOT NULL,
	`device_id` varchar(36) NOT NULL,
	CONSTRAINT `device_group_members_group_id_device_id_pk` PRIMARY KEY(`group_id`,`device_id`)
);
--> statement-breakpoint
CREATE TABLE `device_groups` (
	`id` varchar(36) NOT NULL,
	`owner_user_id` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `device_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `device_groups_owner_name_unique` UNIQUE(`owner_user_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `device_sessions` (
	`id` varchar(36) NOT NULL,
	`device_id` varchar(36) NOT NULL,
	`generation` bigint unsigned NOT NULL,
	`connected_at` datetime(3) NOT NULL,
	`disconnected_at` datetime(3),
	`last_heartbeat_at` datetime(3) NOT NULL,
	`remote_address` varchar(64) NOT NULL,
	`close_reason` varchar(128),
	CONSTRAINT `device_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `device_sessions_generation_unique` UNIQUE(`device_id`,`generation`)
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` varchar(36) NOT NULL,
	`owner_user_id` varchar(36) NOT NULL,
	`public_key` varbinary(128) NOT NULL,
	`computer_name` varchar(255) NOT NULL,
	`platform` varchar(64) NOT NULL,
	`service_version` varchar(64) NOT NULL,
	`session_version` varchar(64) NOT NULL,
	`capabilities` json NOT NULL,
	`disabled_at` datetime(3),
	`credential_revoked_at` datetime(3),
	`last_seen_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `devices_id` PRIMARY KEY(`id`),
	CONSTRAINT `devices_public_key_unique` UNIQUE(`public_key`)
);
--> statement-breakpoint
CREATE TABLE `enrollment_tokens` (
	`id` varchar(36) NOT NULL,
	`owner_user_id` varchar(36) NOT NULL,
	`token_hash` varbinary(32) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `enrollment_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `enrollment_tokens_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `installation_records` (
	`id` varchar(32) NOT NULL,
	`deployment_mode` enum('compose','standalone') NOT NULL,
	`installed_at` datetime(3),
	`schema_version` varchar(64) NOT NULL,
	`state` enum('unconfigured','config_staged','migrating','schema_ready','admin_created','installed') NOT NULL,
	`fencing_token` bigint unsigned NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `installation_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`code_hash` varbinary(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`revoked` boolean NOT NULL DEFAULT false,
	CONSTRAINT `recovery_codes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `system_settings` (
	`key` varchar(128) NOT NULL,
	`value` json NOT NULL,
	`updated_by_user_id` varchar(36),
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `system_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `totp_authenticators` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`algorithm` varchar(32) NOT NULL,
	`key_version` int unsigned NOT NULL,
	`nonce` varbinary(32) NOT NULL,
	`ciphertext` varbinary(512) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`last_successful_counter` bigint unsigned,
	`created_at` datetime(3) NOT NULL,
	`confirmed_at` datetime(3),
	`last_used_at` datetime(3),
	CONSTRAINT `totp_authenticators_id` PRIMARY KEY(`id`),
	CONSTRAINT `totp_authenticators_user_unique` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(36) NOT NULL,
	`identifier_type` enum('email','phone') NOT NULL,
	`normalized_identifier` varchar(320) NOT NULL,
	`display_identifier` varchar(320) NOT NULL,
	`password_hash` varchar(512) NOT NULL,
	`role` enum('admin','user') NOT NULL,
	`status` enum('active','disabled','deleted') NOT NULL DEFAULT 'active',
	`must_change_password` boolean NOT NULL DEFAULT false,
	`temporary_password_expires_at` datetime(3),
	`webauthn_user_handle` varbinary(64) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`deleted_at` datetime(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_identifier_unique` UNIQUE(`identifier_type`,`normalized_identifier`)
);
--> statement-breakpoint
CREATE TABLE `webauthn_credentials` (
	`id` varchar(512) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`public_key` varbinary(2048) NOT NULL,
	`counter` bigint unsigned NOT NULL,
	`transports` json NOT NULL,
	`device_type` varchar(32) NOT NULL,
	`backed_up` boolean NOT NULL,
	`name` varchar(128) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`last_used_at` datetime(3),
	CONSTRAINT `webauthn_credentials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `command_batches` ADD CONSTRAINT `command_batches_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `command_batches` ADD CONSTRAINT `command_batches_initiated_by_user_id_users_id_fk` FOREIGN KEY (`initiated_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `command_results` ADD CONSTRAINT `command_results_command_id_commands_id_fk` FOREIGN KEY (`command_id`) REFERENCES `commands`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commands` ADD CONSTRAINT `commands_batch_id_command_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `command_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commands` ADD CONSTRAINT `commands_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `commands` ADD CONSTRAINT `commands_device_id_devices_id_fk` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `device_group_members` ADD CONSTRAINT `device_group_members_group_id_device_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `device_groups`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `device_group_members` ADD CONSTRAINT `device_group_members_device_id_devices_id_fk` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `device_groups` ADD CONSTRAINT `device_groups_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `device_sessions` ADD CONSTRAINT `device_sessions_device_id_devices_id_fk` FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `devices` ADD CONSTRAINT `devices_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `enrollment_tokens` ADD CONSTRAINT `enrollment_tokens_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `recovery_codes` ADD CONSTRAINT `recovery_codes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `totp_authenticators` ADD CONSTRAINT `totp_authenticators_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `webauthn_credentials` ADD CONSTRAINT `webauthn_credentials_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_events_owner_occurred_idx` ON `audit_events` (`owner_user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_events_action_occurred_idx` ON `audit_events` (`action`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `command_batches_owner_created_idx` ON `command_batches` (`owner_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `command_results_command_received_idx` ON `command_results` (`command_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `commands_owner_status_idx` ON `commands` (`owner_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `devices_owner_last_seen_idx` ON `devices` (`owner_user_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `enrollment_tokens_owner_expiry_idx` ON `enrollment_tokens` (`owner_user_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `recovery_codes_user_active_idx` ON `recovery_codes` (`user_id`,`revoked`);--> statement-breakpoint
CREATE INDEX `users_status_role_idx` ON `users` (`status`,`role`);--> statement-breakpoint
CREATE INDEX `webauthn_credentials_user_idx` ON `webauthn_credentials` (`user_id`);