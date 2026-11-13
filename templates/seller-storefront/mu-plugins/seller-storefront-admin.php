<?php
/*
 * Plugin Name: Seller storefront admin
 * Description: The seller keeps all of wp-admin. This only takes out the upgrade nags of the plugins the storefront comes with (their "Upgrade to Pro" menus, buttons and plugin-row links, and the usage-tracking offers), and asks before AnyPress Host is turned off. Licence pages, add-ons and every setting stay. Part of the storefront template.
 */

if (!is_admin()) {
    return;
}

/** The plugins the storefront template installs (their folders). A plugin the seller adds keeps its own menus and links. */
const SELLER_STOREFRONT_PLUGINS = [
    'anypress-host', 'anypress-blocks', 'betterdocs', 'easy-code-manager', 'fluent-affiliate', 'fluent-booking',
    'fluent-cart', 'fluent-crm', 'fluent-security', 'fluent-support', 'fluent-toolkit', 'fluentform', 'mcp-adapter',
    'wp-fusion-lite',
];

/** Menu items that only sell. Licence and add-on pages stay: that is where a seller enters a Pro licence they bought. */
const SELLER_STOREFRONT_UPSELL_MENU = '/^\s*(upgrade( to pro| now)?|go pro|get pro|pro features|pricing|try [a-z]+!?|[a-z]+ sale|deals?)\s*$/i';

/** Plugins screen links that only sell or ask for a review. */
const SELLER_STOREFRONT_UPSELL_LINK = '/\b(upgrade|go pro|get pro|unlock pro|pro version|buy|rate us|rate it|leave a review)\b/i';

function seller_storefront_template_plugin(string $plugin_file): bool
{
    return in_array(explode('/', $plugin_file)[0], SELLER_STOREFRONT_PLUGINS, true);
}

// Upgrade-only submenu items of the template's plugins.
add_action('admin_menu', function () {
    global $submenu;
    foreach ((array) $submenu as $parent => $items) {
        foreach ((array) $items as $i => $item) {
            $title = trim(wp_strip_all_tags((string) ($item[0] ?? '')));
            if ($title !== '' && preg_match(SELLER_STOREFRONT_UPSELL_MENU, $title) && seller_storefront_template_menu((string) $parent)) {
                unset($submenu[$parent][$i]);
            }
        }
    }
}, PHP_INT_MAX);

/** Whether a top-level menu belongs to one of the template's plugins, from the file of its page's callback. */
function seller_storefront_template_menu(string $parent): bool
{
    global $wp_filter;
    $hook = get_plugin_page_hookname($parent, '');
    foreach (($wp_filter[$hook]->callbacks ?? []) as $callbacks) {
        foreach ($callbacks as $callback) {
            try {
                $fn = $callback['function'];
                $reflection = is_array($fn) ? new ReflectionMethod($fn[0], $fn[1]) : (is_string($fn) && str_contains($fn, '::') ? new ReflectionMethod($fn) : new ReflectionFunction($fn));
                $file = (string) $reflection->getFileName();
            } catch (\Throwable $e) {
                continue;
            }
            $relative = ltrim(str_replace(wp_normalize_path(WP_PLUGIN_DIR), '', wp_normalize_path($file)), '/');
            if (seller_storefront_template_plugin($relative)) {
                return true;
            }
        }
    }
    return false;
}

// On the Plugins screen, the template's plugins keep their Settings and Docs links but lose upgrade and review links.
$seller_storefront_links = static function ($links, $plugin_file) {
    if (!is_array($links) || !seller_storefront_template_plugin((string) $plugin_file)) {
        return $links;
    }
    return array_filter($links, static fn($link) => !preg_match(SELLER_STOREFRONT_UPSELL_LINK, wp_strip_all_tags((string) $link)));
};
add_filter('plugin_row_meta', $seller_storefront_links, PHP_INT_MAX, 2);
add_action('load-plugins.php', function () use ($seller_storefront_links) {
    foreach (array_keys(get_plugins()) as $file) {
        if (seller_storefront_template_plugin($file)) {
            // A plugin's own plugin_action_links_<file> filter runs after the general one.
            add_filter('plugin_action_links_' . $file, $seller_storefront_links, PHP_INT_MAX, 2);
        }
    }
    // AnyPress Host runs checkout and makes customers' websites: say so before it is turned off. Nothing is blocked.
    add_filter('plugin_action_links_anypress-host/anypress-host.php', function ($links) {
        if (isset($links['deactivate'])) {
            $warning = 'Turning off AnyPress Host stops checkout and stops new websites being made for your customers. Turn it off anyway?';
            $links['deactivate'] = str_replace('<a ', '<a onclick="return confirm(' . esc_attr(wp_json_encode($warning)) . ');" ', $links['deactivate']);
        }
        return $links;
    }, PHP_INT_MAX);
});

// Upgrade buttons and Pro boxes inside the template's plugins' own screens.
add_action('admin_head', function () {
    $screen = get_current_screen();
    if (!$screen || !preg_match('/fluent|betterdocs|wp-fusion|wpf|easy-code|snippet/i', (string) $screen->id)) {
        return;
    }
    ?>
    <style>
        .ff_card_pro, .ff_upgrade_btn_large, .fls_dash_promo, .fct-congrats-modal,
        #wpbody a[href*="/pricing"], #wpbody a[href*="utm_medium=upgrade"] { display: none !important; }
    </style>
    <script>
    (function () {
        var sell = /^\s*(upgrade( to pro| now)?|go pro|get pro|buy pro|buy now|unlock( with)? pro|leave a review|write a review|rate us|review [\w ]+ on WordPress\.org\.?)\s*(\(opens in a new (window|tab)\))?\s*$/i;
        function tidy() {
            document.querySelectorAll('#wpbody a, #wpbody button').forEach(function (el) {
                if (sell.test(el.textContent || '')) {
                    el.style.display = 'none';
                }
            });
        }
        document.addEventListener('DOMContentLoaded', function () {
            tidy();
            var body = document.getElementById('wpbody'), queued = false;
            if (body && window.MutationObserver) {
                new MutationObserver(function () {
                    if (queued) return;
                    queued = true;
                    requestAnimationFrame(function () { queued = false; tidy(); });
                }).observe(body, { childList: true, subtree: true });
            }
        });
    })();
    </script>
    <?php
});
