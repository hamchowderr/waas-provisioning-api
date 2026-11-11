<?php
/**
 * FluentSMTP set up with its "simulate emails" switch and the email log on: every email the business sends in the parts after
 * this (receipts, booking confirmations, ticket replies) is listed in the log with its date, and none leaves the demo.
 */
$host = (string) wp_parse_url(home_url(), PHP_URL_HOST);
$sender = 'hello@' . (str_contains($host, '.') ? $host : 'example.com');
$settings = new \FluentMail\App\Models\Settings();
$settings->store([
    'connection_key' => '',
    'connection' => [
        'provider' => 'default',
        'sender_name' => $sample['business']['name'],
        'sender_email' => $sender,
        'force_from_name' => 'yes',
        'force_from_email' => 'yes',
        'return_path' => 'yes',
    ],
    'valid_senders' => [],
]);
$settings->updateMiscSettings(array_merge($settings->getMisc(), ['log_emails' => 'yes', 'log_saved_interval_days' => '90', 'simulate_emails' => 'yes']));
