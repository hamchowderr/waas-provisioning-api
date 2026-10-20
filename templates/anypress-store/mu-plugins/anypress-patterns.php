<?php
/*
 * Plugin Name: AnyPress starter pages
 * Description: Whole-page patterns for each site type (home, about, contact, services), built from the theme's own sections with the store's name in them. They show under "Starter pages" when a page is created, the AnyPress connector's agents find them with find_patterns, and a new store gets real pages made from them for its site type. Also hides the theme's own promotion patterns. Part of the store template.
 */

/** Ollie's patterns that advertise the theme itself rather than the store. */
const ANYPRESS_HIDDEN_PATTERNS = ['ollie/page-download', 'ollie/details-card', 'ollie/text-and-details-card'];

/** Starts and ends an Ollie full-width section; $background is a palette slug, $anchor an id to link to. */
function anypress_section(string $name, string $inner, string $background = '', string $text = '', string $anchor = ''): string
{
    $attrs = [
        'metadata' => ['name' => $name],
        'align' => 'full',
        'style' => ['spacing' => [
            'padding' => ['top' => 'var:preset|spacing|xx-large', 'bottom' => 'var:preset|spacing|xx-large', 'left' => 'var:preset|spacing|medium', 'right' => 'var:preset|spacing|medium'],
            'margin' => ['top' => '0', 'bottom' => '0'],
            'blockGap' => 'var:preset|spacing|large',
        ]],
    ];
    $classes = ['wp-block-group', 'alignfull'];
    if ($text !== '') {
        $attrs['textColor'] = $text;
        $classes[] = "has-$text-color";
    }
    if ($background !== '') {
        $attrs['backgroundColor'] = $background;
    }
    if ($text !== '') {
        $classes[] = 'has-text-color';
    }
    if ($background !== '') {
        array_splice($classes, $text !== '' ? 3 : 2, 0, ["has-$background-background-color"]);
        $classes[] = 'has-background';
    }
    if ($anchor !== '') {
        $attrs['anchor'] = $anchor;
    }
    $attrs['layout'] = ['type' => 'constrained'];

    return '<!-- wp:group ' . wp_json_encode($attrs, JSON_UNESCAPED_SLASHES) . ' -->'
        . '<div' . ($anchor !== '' ? ' id="' . esc_attr($anchor) . '"' : '') . ' class="' . implode(' ', $classes) . '" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-right:var(--wp--preset--spacing--medium);padding-bottom:var(--wp--preset--spacing--xx-large);padding-left:var(--wp--preset--spacing--medium)">'
        . $inner . '</div><!-- /wp:group -->';
}

/** Buttons: [label, url] pairs; the first is the main one. */
function anypress_buttons(array $buttons): string
{
    $html = '<!-- wp:buttons {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"flex","justifyContent":"center"}} --><div class="wp-block-buttons">';
    foreach (array_values($buttons) as $i => [$label, $url]) {
        $html .= $i === 0
            ? '<!-- wp:button --><div class="wp-block-button">'
            : '<!-- wp:button {"className":"is-style-secondary-button"} --><div class="wp-block-button is-style-secondary-button">';
        $html .= '<a class="wp-block-button__link wp-element-button" href="' . esc_url($url) . '">' . esc_html($label) . '</a></div><!-- /wp:button -->';
    }

    return $html . '</div><!-- /wp:buttons -->';
}

/** A small line above a heading. */
function anypress_kicker(string $text): string
{
    return '<!-- wp:paragraph {"align":"center","style":{"typography":{"fontStyle":"normal","fontWeight":"500"}},"textColor":"primary","fontSize":"small"} -->'
        . '<p class="has-text-align-center has-primary-color has-text-color has-small-font-size" style="font-style:normal;font-weight:500">' . esc_html($text) . '</p><!-- /wp:paragraph -->';
}

/** Ollie's Hero Light, without its screenshot. */
function anypress_hero(string $kicker, string $title, string $text, array $buttons): string
{
    return '<!-- wp:cover {"dimRatio":90,"overlayColor":"base","isUserOverlayColor":true,"isDark":false,"metadata":{"name":"Hero"},"align":"full","className":"is-style-blur-image-less","style":{"spacing":{"margin":{"top":"0","bottom":"0"},"padding":{"top":"0","right":"0","bottom":"0","left":"0"}}}} -->'
        . '<div class="wp-block-cover alignfull is-light is-style-blur-image-less" style="margin-top:0;margin-bottom:0;padding-top:0;padding-right:0;padding-bottom:0;padding-left:0"><span aria-hidden="true" class="wp-block-cover__background has-base-background-color has-background-dim-90 has-background-dim"></span><div class="wp-block-cover__inner-container">'
        . '<!-- wp:group {"metadata":{"name":"Hero Wrap"},"align":"full","style":{"spacing":{"margin":{"top":"0px","bottom":"0px"},"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large","right":"var:preset|spacing|medium","left":"var:preset|spacing|medium"},"blockGap":"var:preset|spacing|medium"}},"textColor":"main","layout":{"inherit":true,"type":"constrained"}} -->'
        . '<div class="wp-block-group alignfull has-main-color has-text-color" style="margin-top:0px;margin-bottom:0px;padding-top:var(--wp--preset--spacing--xx-large);padding-right:var(--wp--preset--spacing--medium);padding-bottom:var(--wp--preset--spacing--xx-large);padding-left:var(--wp--preset--spacing--medium)">'
        . anypress_kicker($kicker)
        . '<!-- wp:heading {"textAlign":"center","level":1,"className":"has-secondary-font-family","style":{"typography":{"fontSize":"4rem"}}} -->'
        . '<h1 class="wp-block-heading has-text-align-center has-secondary-font-family" style="font-size:4rem">' . esc_html($title) . '</h1><!-- /wp:heading -->'
        . '<!-- wp:paragraph {"align":"center","textColor":"secondary"} --><p class="has-text-align-center has-secondary-color has-text-color">' . esc_html($text) . '</p><!-- /wp:paragraph -->'
        . anypress_buttons($buttons)
        . '</div><!-- /wp:group --></div></div><!-- /wp:cover -->';
}

/** A centred heading with a paragraph under it. */
function anypress_titles(string $kicker, string $title, string $text = ''): string
{
    return '<!-- wp:group {"metadata":{"name":"Titles"},"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"constrained"}} --><div class="wp-block-group">'
        . anypress_kicker($kicker)
        . '<!-- wp:heading {"textAlign":"center"} --><h2 class="wp-block-heading has-text-align-center">' . esc_html($title) . '</h2><!-- /wp:heading -->'
        . ($text !== '' ? '<!-- wp:paragraph {"align":"center","textColor":"secondary"} --><p class="has-text-align-center has-secondary-color has-text-color">' . esc_html($text) . '</p><!-- /wp:paragraph -->' : '')
        . '</div><!-- /wp:group -->';
}

/** Ollie's Features With Emojis: [emoji, title, text] items in a grid. */
function anypress_features(string $kicker, string $title, array $items): string
{
    $grid = '<!-- wp:group {"align":"wide","style":{"spacing":{"blockGap":"var:preset|spacing|large"}},"layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"14rem"}} --><div class="wp-block-group alignwide">';
    foreach ($items as [$emoji, $heading, $text]) {
        $grid .= '<!-- wp:group {"metadata":{"name":"Feature"},"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"constrained"}} --><div class="wp-block-group">'
            . '<!-- wp:paragraph {"fontSize":"large"} --><p class="has-large-font-size">' . esc_html($emoji) . '</p><!-- /wp:paragraph -->'
            . '<!-- wp:heading {"level":3} --><h3 class="wp-block-heading">' . esc_html($heading) . '</h3><!-- /wp:heading -->'
            . '<!-- wp:paragraph {"textColor":"secondary"} --><p class="has-secondary-color has-text-color">' . esc_html($text) . '</p><!-- /wp:paragraph -->'
            . '</div><!-- /wp:group -->';
    }
    $grid .= '</div><!-- /wp:group -->';

    return anypress_section('Features', anypress_titles($kicker, $title) . $grid);
}

/** Questions and answers that open on click. */
function anypress_faq(string $title, array $items): string
{
    $list = '<!-- wp:group {"metadata":{"name":"Questions"},"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"constrained"}} --><div class="wp-block-group">';
    foreach ($items as [$question, $answer]) {
        $list .= '<!-- wp:details --><details class="wp-block-details"><summary>' . esc_html($question) . '</summary>'
            . '<!-- wp:paragraph {"placeholder":"Type / to add a hidden block"} --><p>' . esc_html($answer) . '</p><!-- /wp:paragraph --></details><!-- /wp:details -->';
    }
    $list .= '</div><!-- /wp:group -->';

    return anypress_section('FAQ', anypress_titles(__('Questions', 'anypress'), $title) . $list, 'tertiary');
}

/** Ollie's Text Call To Action Buttons. */
function anypress_call_to_action(string $kicker, string $title, string $text, array $buttons): string
{
    return anypress_section('Call To Action', anypress_titles($kicker, $title, $text) . anypress_buttons($buttons), 'tertiary');
}

/** A heading over a plugin's shortcode (a product list, a booking calendar, a form). */
function anypress_embed(string $kicker, string $title, string $shortcode, string $anchor = ''): string
{
    return anypress_section('Embed', anypress_titles($kicker, $title) . '<!-- wp:shortcode -->' . $shortcode . '<!-- /wp:shortcode -->', '', '', $anchor);
}

/** Paragraphs of text under a heading, for an About page. */
function anypress_story(string $kicker, string $title, array $paragraphs): string
{
    $text = '<!-- wp:group {"metadata":{"name":"Text"},"layout":{"type":"constrained","contentSize":"640px"}} --><div class="wp-block-group">';
    foreach ($paragraphs as $paragraph) {
        $text .= '<!-- wp:paragraph --><p>' . esc_html($paragraph) . '</p><!-- /wp:paragraph -->';
    }
    $text .= '</div><!-- /wp:group -->';

    return anypress_section('Story', anypress_titles($kicker, $title) . $text);
}

/** The page patterns, by slug: title, keywords, the plugin it needs (or ''), and a function giving its blocks. */
function anypress_starter_pages(): array
{
    $name = wp_specialchars_decode((string) get_option('blogname'), ENT_QUOTES) ?: __('Your business', 'anypress');
    $url = fn (string $path) => home_url($path);
    $page = function (string $slug, string $fallback) {
        $found = get_page_by_path($slug);

        return $found && $found->post_status === 'publish' ? get_permalink($found) : home_url($fallback);
    };
    $contact = fn () => $page('contact', '/contact/');
    $about = [__('About us', 'anypress'), $page('about', '/about/')];

    return [
        'anypress/home-website' => [__('Home: website', 'anypress'), 'home, homepage, front page, landing', '', fn () =>
            anypress_hero(__('Welcome', 'anypress'), $name, __('Say in a sentence or two what you do and who it is for.', 'anypress'), [[__('Get in touch', 'anypress'), $contact()], $about])
            . anypress_features(__('What we do', 'anypress'), __('How we can help', 'anypress'), [
                ['✨', __('First service', 'anypress'), __('What it is, who it is for, and what they get from it.', 'anypress')],
                ['🤝', __('Second service', 'anypress'), __('What it is, who it is for, and what they get from it.', 'anypress')],
                ['🚀', __('Third service', 'anypress'), __('What it is, who it is for, and what they get from it.', 'anypress')],
            ])
            . anypress_call_to_action(__('Get started', 'anypress'), __('Ready when you are', 'anypress'), __('Tell us what you need and we will get back to you.', 'anypress'), [[__('Contact us', 'anypress'), $contact()]]),
        ],
        'anypress/home-store' => [__('Home: online store', 'anypress'), 'home, homepage, shop, store, products', 'fluent-cart/fluent-cart.php', fn () =>
            anypress_hero(__('New in', 'anypress'), $name, __('Say in a sentence what you sell and why people love it.', 'anypress'), [[__('Shop now', 'anypress'), $page('shop', '/shop/')], $about])
            . anypress_embed(__('Shop', 'anypress'), __('Our products', 'anypress'), '[fluent_cart_products per_page="6" paginator="numbers"]')
            . anypress_features(__('Why shop with us', 'anypress'), __('Good to know', 'anypress'), [
                ['📦', __('Shipping', 'anypress'), __('Where you ship to and how long it takes.', 'anypress')],
                ['🔒', __('Secure checkout', 'anypress'), __('Pay safely by card. Your details are never stored on this site.', 'anypress')],
                ['↩️', __('Returns', 'anypress'), __('How returns and refunds work.', 'anypress')],
            ])
            . anypress_faq(__('Before you order', 'anypress'), [
                [__('How long does delivery take?', 'anypress'), __('Say how long orders take to arrive.', 'anypress')],
                [__('Can I return an order?', 'anypress'), __('Explain your returns policy.', 'anypress')],
                [__('How do I track my order?', 'anypress'), __('Orders and their status are in your account.', 'anypress')],
            ]),
        ],
        'anypress/home-bookings' => [__('Home: bookings', 'anypress'), 'home, homepage, bookings, appointments, services', 'fluent-booking/fluent-booking.php', fn () =>
            anypress_hero(__('Book online', 'anypress'), $name, __('Say what you offer, and that booking takes a minute.', 'anypress'), [[__('Book now', 'anypress'), '#book'], [__('Our services', 'anypress'), $page('services', '/services/')]])
            . anypress_features(__('Services', 'anypress'), __('What you can book', 'anypress'), [
                ['🗓️', __('First service', 'anypress'), __('What it is, how long it takes and what it costs.', 'anypress')],
                ['💬', __('Second service', 'anypress'), __('What it is, how long it takes and what it costs.', 'anypress')],
                ['⭐', __('Third service', 'anypress'), __('What it is, how long it takes and what it costs.', 'anypress')],
            ])
            . anypress_booking()
            . anypress_faq(__('Before you book', 'anypress'), [
                [__('Can I change or cancel a booking?', 'anypress'), __('Explain how much notice you need.', 'anypress')],
                [__('Where do we meet?', 'anypress'), __('Say where, or how online sessions work.', 'anypress')],
            ]),
        ],
        'anypress/home-community' => [__('Home: community and courses', 'anypress'), 'home, homepage, community, courses, members, membership', 'fluent-community/fluent-community.php', fn () =>
            anypress_hero(__('Join us', 'anypress'), $name, __('Say who the community is for and what members learn or get.', 'anypress'), [[__('Join the community', 'anypress'), anypress_portal_url()], $about])
            . anypress_features(__('Inside', 'anypress'), __('What members get', 'anypress'), [
                ['🎓', __('Courses', 'anypress'), __('What the courses teach, and at what pace.', 'anypress')],
                ['💬', __('Discussions', 'anypress'), __('Ask questions and share wins with people on the same path.', 'anypress')],
                ['📅', __('Events', 'anypress'), __('Live sessions, calls or meetups members can join.', 'anypress')],
            ])
            . anypress_call_to_action(__('Get started', 'anypress'), __('Come and join us', 'anypress'), __('Sign up in a minute and start today.', 'anypress'), [[__('Join the community', 'anypress'), anypress_portal_url()]]),
        ],
        'anypress/services' => [__('Services', 'anypress'), 'services, prices, pricing, treatments, menu', '', fn () =>
            anypress_hero(__('Services', 'anypress'), __('What we offer', 'anypress'), __('A short line on how you work with people.', 'anypress'), [[__('Get in touch', 'anypress'), $contact()]])
            . anypress_features(__('Prices', 'anypress'), __('Services and prices', 'anypress'), [
                ['1️⃣', __('First service', 'anypress'), __('What is included, how long it takes and the price.', 'anypress')],
                ['2️⃣', __('Second service', 'anypress'), __('What is included, how long it takes and the price.', 'anypress')],
                ['3️⃣', __('Third service', 'anypress'), __('What is included, how long it takes and the price.', 'anypress')],
            ])
            . anypress_call_to_action(__('Next step', 'anypress'), __('Not sure which one is right?', 'anypress'), __('Ask us and we will help you choose.', 'anypress'), [[__('Contact us', 'anypress'), $contact()]]),
        ],
        'anypress/about' => [__('About', 'anypress'), 'about, story, team, values', '', fn () =>
            anypress_story(__('About us', 'anypress'), sprintf(__('The story of %s', 'anypress'), $name), [
                __('How it started, and why.', 'anypress'),
                __('Who you work with today, and what you care about getting right for them.', 'anypress'),
            ])
            . anypress_features(__('Values', 'anypress'), __('What we stand for', 'anypress'), [
                ['💡', __('First value', 'anypress'), __('What it means for the people you serve.', 'anypress')],
                ['🌱', __('Second value', 'anypress'), __('What it means for the people you serve.', 'anypress')],
                ['❤️', __('Third value', 'anypress'), __('What it means for the people you serve.', 'anypress')],
            ])
            . anypress_call_to_action(__('Say hello', 'anypress'), __('We would love to hear from you', 'anypress'), '', [[__('Contact us', 'anypress'), $contact()]]),
        ],
        'anypress/contact' => [__('Contact', 'anypress'), 'contact, form, email, phone, address, location', '', fn () =>
            anypress_features(__('Contact', 'anypress'), __('Get in touch', 'anypress'), [
                ['✉️', __('Email', 'anypress'), (string) get_option('admin_email')],
                ['📞', __('Phone', 'anypress'), __('Your phone number, and when you answer.', 'anypress')],
                ['📍', __('Visit', 'anypress'), __('Your address, or the area you serve.', 'anypress')],
            ])
            . anypress_contact_form(),
        ],
    ];
}

/** The booking calendar, once the owner has made one in FluentBooking; until then a line saying so. */
function anypress_booking(): string
{
    global $wpdb;
    $calendar = (int) $wpdb->get_var("SELECT id FROM {$wpdb->prefix}fcal_calendars WHERE status = 'active' ORDER BY id LIMIT 1");

    return $calendar
        ? anypress_embed(__('Book', 'anypress'), __('Pick a time', 'anypress'), '[fluent_booking_calendar calendar_id="' . $calendar . '"]', 'book')
        : anypress_section('Booking', anypress_titles(__('Book', 'anypress'), __('Pick a time', 'anypress'), __('Online booking opens here soon.', 'anypress')), '', '', 'book');
}

/** Fluent Forms' contact form, when it is on. */
function anypress_contact_form(): string
{
    if (!function_exists('wpFluent')) {
        return '';
    }
    $form = (int) (wpFluent()->table('fluentform_forms')->where('title', 'Contact Form Demo')->value('id') ?: 0);

    return $form ? anypress_embed(__('Message', 'anypress'), __('Send us a message', 'anypress'), '[fluentform id="' . $form . '"]') : '';
}

function anypress_portal_url(): string
{
    return class_exists('\FluentCommunity\App\Services\Helper') ? \FluentCommunity\App\Services\Helper::baseUrl() : home_url('/portal/');
}

/*
 * Patterns are only read by the editor and the REST API (the block editor, the connector's find_patterns), so they
 * are registered there, not on every page view: building them looks up pages, the contact form and the calendar.
 */
function anypress_register_patterns(): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;
    foreach (ANYPRESS_HIDDEN_PATTERNS as $pattern) {
        if (WP_Block_Patterns_Registry::get_instance()->is_registered($pattern)) {
            unregister_block_pattern($pattern);
        }
    }
    register_block_pattern_category('anypress/pages', ['label' => __('Starter pages', 'anypress'), 'description' => __('Whole pages to start from, for this kind of website.', 'anypress')]);
    $active = (array) get_option('active_plugins', []);
    foreach (anypress_starter_pages() as $slug => [$title, $keywords, $needs, $content]) {
        if ($needs !== '' && !in_array($needs, $active, true)) {
            continue;
        }
        register_block_pattern($slug, [
            'title' => $title,
            'categories' => ['anypress/pages'],
            'keywords' => array_map('trim', explode(',', $keywords)),
            'postTypes' => ['page'],
            'blockTypes' => ['core/post-content'],
            'content' => $content(),
        ]);
    }
}
add_action('admin_init', 'anypress_register_patterns');
add_action('rest_api_init', 'anypress_register_patterns');

/**
 * The pages a new store starts with, by its site type (the plugins its plan switched on): page slug => starter page.
 * A store with FluentCart keeps the shop as its home page; the others get a home page of their own.
 */
function anypress_site_type_pages(array $active): array
{
    $on = fn (string $plugin) => in_array($plugin, $active, true);
    if ($on('fluent-cart/fluent-cart.php')) {
        return ['about' => 'anypress/about', 'contact' => 'anypress/contact'];
    }
    if ($on('fluent-booking/fluent-booking.php')) {
        return ['home' => 'anypress/home-bookings', 'services' => 'anypress/services', 'about' => 'anypress/about', 'contact' => 'anypress/contact'];
    }
    if ($on('fluent-community/fluent-community.php')) {
        return ['home' => 'anypress/home-community', 'about' => 'anypress/about', 'contact' => 'anypress/contact'];
    }

    return ['home' => 'anypress/home-website', 'services' => 'anypress/services', 'about' => 'anypress/about', 'contact' => 'anypress/contact'];
}

/*
 * Real pages from the starter pages, once per store, so a new store opens on a finished-looking site: published, in
 * the main menu, and with Home as the front page. Runs on the first web request that has the owner's email (the
 * platform sets it, and the site title, when it creates the store), after the site type has switched the plugins
 * (anypress-store.php, priority 9999). A store whose owner already made pages of their own is left alone.
 */
add_action('init', function () {
    if ((defined('WP_CLI') && WP_CLI) || get_option('anypress_starter_pages_made')) {
        return;
    }
    $email = (string) get_option('admin_email');
    if (!is_email($email) || substr($email, -8) === '.invalid' || get_option('anypress_site_type_plugins') === false) {
        return;
    }
    // A plugin the site type switched on during this request hasn't loaded yet (the contact form needs Fluent Forms).
    $active = (array) get_option('active_plugins', []);
    $boot = anypress_boot_plugins();
    sort($active);
    sort($boot);
    if ($active !== $boot) {
        return;
    }
    // Two requests at once: only one makes the pages. A lock older than a minute was left by a request that died.
    $lock = get_option('anypress_starter_pages_lock');
    if ($lock !== false && time() - (int) $lock < 60) {
        return;
    }
    if ($lock !== false) {
        delete_option('anypress_starter_pages_lock');
    }
    if (!add_option('anypress_starter_pages_lock', time(), '', false)) {
        return;
    }
    // The template's own pages (FluentCart's, the support portal) all carry _anypress_needs; any other page is the owner's.
    $own = get_posts([
        'post_type' => 'page',
        'post_status' => 'any',
        'numberposts' => 1,
        'fields' => 'ids',
        'suppress_filters' => true,
        'meta_query' => [['key' => '_anypress_needs', 'compare' => 'NOT EXISTS']],
    ]);
    if (!$own) {
        anypress_make_starter_pages($email);
    }
    update_option('anypress_starter_pages_made', time(), true);
    delete_option('anypress_starter_pages_lock');
}, 10000);

function anypress_make_starter_pages(string $email): void
{
    $author = (int) (get_user_by('email', $email)?->ID ?: (get_users(['role' => 'administrator', 'number' => 1, 'fields' => 'ID'])[0] ?? 0));
    $pages = anypress_site_type_pages((array) get_option('active_plugins', []));
    $starters = anypress_starter_pages();
    // The patterns' blocks carry inline styles; on a request with no signed-in admin, kses would strip them.
    kses_remove_filters();
    // Every page first, so the links between them (Get in touch, About us) point at real pages.
    $ids = [];
    foreach ($pages as $slug => $pattern) {
        $title = $slug === 'home' ? __('Home', 'anypress') : $starters[$pattern][0];
        $id = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => $title, 'post_name' => $slug, 'post_author' => $author, 'comment_status' => 'closed', 'ping_status' => 'closed',
            // The starter pages are full-width sections that open with their own heading.
            'page_template' => 'page-no-title'], true);
        if (!is_wp_error($id)) {
            $ids[$slug] = $id;
        }
    }
    foreach ($ids as $slug => $id) {
        wp_update_post(['ID' => $id, 'post_content' => $starters[$pages[$slug]][3]()]);
    }
    if (isset($ids['home'])) {
        update_option('show_on_front', 'page');
        update_option('page_on_front', $ids['home']);
        // The site type saved the hidden shop as the home page to bring back; Home stays the home page now.
        delete_option('anypress_front_page');
    }
    anypress_add_to_menu(array_diff_key($ids, ['home' => true]));
    kses_init();
}

/** Adds the pages to the template's main menu: after Shop when the store has one, otherwise first. */
function anypress_add_to_menu(array $ids): void
{
    $menu = get_posts(['post_type' => 'wp_navigation', 'title' => 'Main menu', 'numberposts' => 1, 'suppress_filters' => true]);
    if (!$menu || !$ids) {
        return;
    }
    $blocks = parse_blocks($menu[0]->post_content);
    $links = [];
    foreach ($ids as $id) {
        $links[] = ['blockName' => 'core/navigation-link', 'attrs' => ['label' => get_the_title($id), 'type' => 'page', 'id' => $id, 'url' => get_permalink($id), 'kind' => 'post-type'], 'innerBlocks' => [], 'innerHTML' => '', 'innerContent' => []];
    }
    $shop = (int) get_page_by_path('shop')?->ID;
    $at = 0;
    foreach ($blocks as $i => $block) {
        if ($shop && (int) ($block['attrs']['id'] ?? 0) === $shop && get_post_status($shop) === 'publish') {
            $at = $i + 1;
        }
    }
    array_splice($blocks, $at, 0, $links);
    wp_update_post(['ID' => $menu[0]->ID, 'post_content' => serialize_blocks($blocks)]);
}
