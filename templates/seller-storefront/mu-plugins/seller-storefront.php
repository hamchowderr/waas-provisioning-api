<?php
/*
 * Plugin Name: Seller storefront defaults
 * Description: Settings the seller storefront template keeps in code: WP Fusion kept out of staging mode and the owner’s details filled in once (FluentCRM, FluentCart, Fluent Support, FluentBooking, FluentAffiliate). Buyers and leads are tagged by the AnyPress CRM lifecycle plugin. Part of the storefront template.
 */

// WP Fusion compares the site URL with the one it was set up on and stops syncing when they differ. Every
// storefront is a clone of the template and can change domain, so that check would switch it off.
if (!defined('WPF_STAGING_MODE')) {
    define('WPF_STAGING_MODE', false);
}
add_filter('wp_fusion_hide_upgrade_nags', '__return_true');

/*
 * The owner's details, filled in once. The API sets the site title and admin email after the storefront is made from
 * the template, so FluentCRM's business name and email (its email footers) wait for the first web request that has a
 * real admin email. The other plugins' copies of the owner's name and email follow in the same step.
 */
add_action('init', function () {
    if ((defined('WP_CLI') && WP_CLI) || get_option('seller_storefront_owner_applied') || !defined('FLUENTCRM')) {
        return;
    }
    $email = (string) get_option('admin_email');
    if (!is_email($email) || substr($email, -8) === '.invalid') {
        return;
    }
    if (!add_option('seller_storefront_owner_applied', time(), '', false)) {
        return;
    }
    $crm = get_option('fluentcrm-global-settings', []);
    $crm['business_settings'] = array_merge($crm['business_settings'] ?? ['business_address' => '', 'logo' => ''], [
        'business_name' => wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES),
        'admin_email' => $email,
    ]);
    update_option('fluentcrm-global-settings', $crm);

    $name = wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES);
    $owner = get_user_by('email', $email);
    $steps = [
        // FluentCart: the store's name on receipts and invoices.
        'fluent-cart' => static fn() => (new \FluentCart\Api\StoreSettings())->save(['store_name' => $name]),
        // Fluent Support: its first mailbox, which the Support page's requests need, under the owner's name and email.
        'fluent-support' => static function () use ($name, $email, $owner) {
            if (!\FluentSupport\App\Models\MailBox::first()) {
                \FluentSupport\App\Models\MailBox::create(['name' => $name, 'email' => $email, 'box_type' => 'web', 'is_default' => 'yes', 'created_by' => $owner ? $owner->ID : 0, 'settings' => ['admin_email_address' => $email]]);
            }
        },
        // FluentBooking: the Book a call calendar, made for the template's admin, moves to the owner.
        'fluent-booking' => static function () use ($owner, $name) {
            if ($owner) {
                \FluentBooking\App\Models\Calendar::query()->update(['user_id' => $owner->ID, 'title' => $name]);
                \FluentBooking\App\Models\CalendarSlot::query()->update(['user_id' => $owner->ID]);
            }
        },
        // FluentAffiliate: where its notices about new referrers go.
        'fluent-affiliate' => static function () use ($email) {
            $utility = '\FluentAffiliate\App\Helper\Utility';
            $utility::updateOption('global_email_settings', array_merge($utility::defaultEmailSettings(), (array) $utility::getOption('global_email_settings', []), ['admin_email' => $email]));
        },
    ];
    foreach ($steps as $plugin => $step) {
        try {
            $step();
        } catch (\Throwable $e) {
            error_log("Seller storefront: owner details for $plugin: " . $e->getMessage()); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- one plugin's setup failing must not stop the rest.
        }
    }

    // The shop narrowed to what the seller said they sell and who they sell to (the API's anypress_storefront_setup,
    // from their application): the template's pages made again with only those plans and Who we help pages.
    $kit = WP_CONTENT_DIR . '/anypress-storefront/pages.php';
    if (get_option('anypress_storefront_setup') && is_readable($kit)) {
        // Remaking the pages takes longer than an ordinary page load; let it finish even if the visitor leaves.
        ignore_user_abort(true);
        if (function_exists('set_time_limit')) {
            set_time_limit(300);
        }
        $before = get_current_user_id();
        if ($owner) {
            wp_set_current_user($owner->ID);
        }
        ob_start();
        try {
            (static function () use ($kit) {
                require $kit;
            })();
            update_option('seller_storefront_pages_made', time(), false);
        } catch (\Throwable $e) {
            error_log('Seller storefront: pages for the seller\'s site types not made: ' . $e->getMessage()); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- the template's full shop stays; the store's log is where it is looked into.
        }
        ob_end_clean();
        wp_set_current_user($before);
    }
}, 9999);

/*
 * The seller's look from the dashboard's Branding page (the API's anypress_storefront_brand, docs/branding.md): the
 * site title, logo, browser-tab icon, the theme's accent colour and the Support page's mailbox. Applied once per change,
 * on the first web request after the API writes it; a field left empty leaves what the shop has.
 */
add_action('init', function () {
    $raw = (string) get_option('anypress_storefront_brand', '');
    if ($raw === '' || (defined('WP_CLI') && WP_CLI) || get_option('seller_storefront_brand_applied') === $raw) {
        return;
    }
    $brand = json_decode($raw, true);
    // One request applies it; others carry on while it runs.
    if (!is_array($brand) || get_transient('seller_storefront_brand_lock')) {
        return;
    }
    set_transient('seller_storefront_brand_lock', 1, 120);
    // What went on before, field by field: an unchanged logo isn't downloaded again.
    $before = json_decode((string) get_option('seller_storefront_brand_fields', ''), true);
    $before = is_array($before) ? $before : [];
    $changed = static fn(string $field) => !empty($brand[$field]) && ($before[$field] ?? null) !== $brand[$field];

    $steps = [
        'name' => static function () use ($brand) {
            update_option('blogname', sanitize_text_field($brand['name']));
            if (class_exists('\FluentCart\Api\StoreSettings')) {
                (new \FluentCart\Api\StoreSettings())->save(['store_name' => sanitize_text_field($brand['name'])]);
            }
        },
        'logoUrl' => static function () use ($brand) {
            $id = seller_storefront_brand_image((string) $brand['logoUrl'], 'logo');
            update_option('site_logo', $id);
            set_theme_mod('custom_logo', $id);
        },
        'iconUrl' => static function () use ($brand) {
            update_option('site_icon', seller_storefront_brand_image((string) $brand['iconUrl'], 'icon'));
        },
        'color' => static function () use ($brand) {
            seller_storefront_brand_colour((string) $brand['color']);
        },
        'supportEmail' => static function () use ($brand) {
            $email = sanitize_email((string) $brand['supportEmail']);
            if ($email && class_exists('\FluentSupport\App\Models\MailBox')) {
                \FluentSupport\App\Models\MailBox::query()->where('is_default', 'yes')->update(['email' => $email]);
            }
        },
    ];
    $applied = $before;
    foreach ($steps as $field => $step) {
        if (!$changed($field)) {
            continue;
        }
        try {
            $step();
            $applied[$field] = $brand[$field];
        } catch (\Throwable $e) {
            error_log("Seller storefront: branding $field not applied: " . $e->getMessage()); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- the rest of the look still goes on; the store's log is where it is looked into.
        }
    }
    // Only what went on counts, so a field that failed is tried again with the next change.
    update_option('seller_storefront_brand_fields', wp_json_encode($applied), false);
    update_option('seller_storefront_brand_applied', $raw, false);
    delete_transient('seller_storefront_brand_lock');
}, 10000);

/** The logo or icon from the API, added to the Media Library; its attachment id. */
function seller_storefront_brand_image(string $url, string $kind): int
{
    if (!wp_http_validate_url($url)) {
        throw new \RuntimeException("not a link: $url");
    }
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';
    $file = download_url($url, 30);
    if (is_wp_error($file)) {
        throw new \RuntimeException($file->get_error_message());
    }
    $ext = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/webp' => 'webp', 'image/x-icon' => 'ico'][(string) wp_get_image_mime($file)] ?? (str_ends_with(strtolower($url), '.ico') ? 'ico' : 'png');
    $id = media_handle_sideload(['name' => "brand-$kind.$ext", 'tmp_name' => $file], 0, ucfirst($kind));
    if (is_wp_error($id)) {
        wp_delete_file($file);
        throw new \RuntimeException($id->get_error_message());
    }
    return (int) $id;
}

/**
 * The seller's main colour in the site's own Global Styles, so it can still be changed in the Site Editor: as the
 * theme's accent (`primary`: links, small coloured text and the buttons that use it), darkened until text in it keeps
 * WCAG AA contrast (4.5:1) on white; and light tints of it for the highlight behind headline words (`primary-alt`) and
 * pale panels (`primary-accent`), which dark text sits on.
 */
function seller_storefront_brand_colour(string $hex): void
{
    if (!preg_match('/^#([0-9a-f]{6})$/i', $hex, $m)) {
        throw new \RuntimeException("not a colour: $hex");
    }
    $rgb = array_map('hexdec', str_split($m[1], 2));
    $tint = static fn(float $t) => vsprintf('#%02x%02x%02x', array_map(static fn($v) => (int) round($v + (255 - $v) * $t), $rgb));
    $colours = ['primary-alt' => $tint(0.55), 'primary-accent' => $tint(0.88)];
    $luminance = static function (array $c): float {
        $l = array_map(static fn($v) => ($v /= 255) <= 0.03928 ? $v / 12.92 : (($v + 0.055) / 1.055) ** 2.4, $c);
        return 0.2126 * $l[0] + 0.7152 * $l[1] + 0.0722 * $l[2];
    };
    for ($i = 0; $i < 40 && 1.05 / ($luminance($rgb) + 0.05) < 4.5; $i++) {
        $rgb = array_map(static fn($v) => (int) floor($v * 0.92), $rgb);
    }
    $colours['primary'] = vsprintf('#%02x%02x%02x', $rgb);

    $post = WP_Theme_JSON_Resolver::get_user_data_from_wp_global_styles(wp_get_theme(), true);
    if (empty($post['ID'])) {
        throw new \RuntimeException('no Global Styles post');
    }
    $styles = json_decode($post['post_content'], true) ?: ['version' => 3, 'isGlobalStylesUserThemeJSON' => true];
    $palette = $styles['settings']['color']['palette']['theme']
        ?? (wp_get_global_settings(['color', 'palette'], ['origin' => 'theme'])['theme'] ?? []);
    foreach ($palette as &$entry) {
        if (isset($colours[$entry['slug'] ?? ''])) {
            $entry['color'] = $colours[$entry['slug']];
            unset($colours[$entry['slug']]);
        }
    }
    unset($entry);
    foreach ($colours as $slug => $colour) {
        $palette[] = ['slug' => $slug, 'name' => ucwords(str_replace('-', ' ', $slug)), 'color' => $colour];
    }
    $styles['settings']['color']['palette']['theme'] = $palette;
    $saved = wp_update_post(['ID' => $post['ID'], 'post_content' => wp_slash(wp_json_encode($styles))], true);
    if (is_wp_error($saved)) {
        throw new \RuntimeException($saved->get_error_message());
    }
    wp_clean_theme_json_cache();
}
