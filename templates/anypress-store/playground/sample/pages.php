<?php
/**
 * The public site as the business's own: a home page, about, contact and services pages written for it (with the
 * template's own starter-page sections, in place of the starter pages a new store makes), a blog page with the latest posts, the newsletter sign-up and its own form
 * on a page, and the menu to match. Each page and the menu keep a fingerprint of what the sample wrote
 * (_anypress_sample), so "Make this my site" leaves behind what the visitor did not change.
 */
if (!function_exists('anypress_hero') || empty($sample['pages'])) {
    return;
}
$copy = $sample['pages'];
$name = $sample['business']['name'];

// The pages the store already has (Home, About, Contact, Services), and new ones made like them.
$pageFor = static function (string $slug, string $title): int {
    $found = get_page_by_path($slug);
    if ($found) {
        return (int) $found->ID;
    }
    $id = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => $title, 'post_name' => $slug, 'comment_status' => 'closed', 'page_template' => 'page-no-title']);
    return is_wp_error($id) ? 0 : (int) $id;
};
$ids = ['home' => $pageFor('home', 'Home')];
update_option('show_on_front', 'page');
update_option('page_on_front', $ids['home']);
delete_option('anypress_front_page');
// These are the store's pages now: the first visit doesn't make the template's starter pages over them.
update_option('anypress_starter_pages_made', time(), true);
foreach (['about' => 'About', 'contact' => 'Contact'] as $slug => $title) {
    $ids[$slug] = $pageFor($slug, $title);
}
[$blogTitle, $latestTitle] = $copy['blog'];
$ids['blog'] = $pageFor('blog', $blogTitle);
wp_update_post(['ID' => $ids['blog'], 'post_title' => $blogTitle, 'page_template' => '']);
update_option('page_for_posts', $ids['blog']);
if (!empty($copy['services'])) {
    [$servicesTitle, $servicesSlug] = $copy['services'];
    $ids['services'] = $pageFor($servicesSlug, $servicesTitle);
}
if (!empty($copy['intake'])) {
    $ids['intake'] = $pageFor($copy['intake'][1], $copy['intake'][0]);
}

/** A button's address: a page by slug, an anchor on the page, or the community portal. */
$url = static function (string $to) use ($ids): string {
    if ($to === 'portal') {
        return anypress_portal_url();
    }
    if ($to[0] === '#') {
        return $to;
    }
    if (isset($ids[$to])) {
        return get_permalink($ids[$to]);
    }
    $page = get_page_by_path($to);
    return $page ? get_permalink($page) : home_url('/' . $to . '/');
};
$buttons = static fn (array $list) => array_map(static fn ($b) => [$b[0], $url($b[1])], $list);

/** A Fluent Forms form on the page, by its title. */
$form = static function (array $titles): int {
    return class_exists('\FluentForm\App\Models\Form') ? (int) (\FluentForm\App\Models\Form::whereIn('title', $titles)->value('id') ?: 0) : 0;
};

/** The hero with a photo beside the words: the theme's brand section around a media and text block. */
$hero = static function (string $title, string $text, array $links, int $photo): string {
    if (!$photo) {
        return anypress_hero($title, $text, $links);
    }
    $src = (string) wp_get_attachment_image_url($photo, 'large');
    $alt = esc_attr((string) get_post_meta($photo, '_wp_attachment_image_alt', true));
    return anypress_section(
        'Hero',
        '<!-- wp:media-text {"align":"wide","mediaId":' . $photo . ',"mediaLink":"","mediaType":"image","verticalAlignment":"center","imageFill":false} -->'
        . '<div class="wp-block-media-text alignwide is-stacked-on-mobile is-vertically-aligned-center"><figure class="wp-block-media-text__media"><img src="' . esc_url($src) . '" alt="' . $alt . '" class="wp-image-' . $photo . ' size-full"/></figure><div class="wp-block-media-text__content">'
        . '<!-- wp:heading {"level":1,"fontSize":"xxx-large"} --><h1 class="wp-block-heading has-xxx-large-font-size">' . esc_html($title) . '</h1><!-- /wp:heading -->'
        . '<!-- wp:paragraph {"fontSize":"medium"} --><p class="has-medium-font-size">' . esc_html($text) . '</p><!-- /wp:paragraph -->'
        . anypress_buttons($links)
        . '</div></div><!-- /wp:media-text -->',
        'brand',
        '80rem'
    );
};

/** The newest posts with their photos, three to a row, and a link to the blog page. */
$latest = static function (string $title) use ($ids): string {
    return anypress_section(
        'Latest posts',
        anypress_titles($title)
        . '<!-- wp:query {"queryId":7,"query":{"perPage":3,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","inherit":false},"align":"wide"} -->'
        . '<div class="wp-block-query alignwide"><!-- wp:post-template {"layout":{"type":"grid","columnCount":3}} -->'
        . '<!-- wp:post-featured-image {"isLink":true,"aspectRatio":"3/2"} /-->'
        . '<!-- wp:post-title {"isLink":true,"level":3,"fontSize":"large"} /-->'
        . '<!-- wp:post-excerpt {"excerptLength":22} /-->'
        . '<!-- /wp:post-template --></div><!-- /wp:query -->'
        . anypress_buttons([[__('All posts'), get_permalink($ids['blog'])]]),
        'tint'
    );
};

// The hero's photo: one of the blog's (the post the business picked, or its first).
$heroPost = get_posts(['post_type' => 'post', 'post_status' => 'publish', 'numberposts' => 1, 'fields' => 'ids', 'title' => $sample['posts'][$copy['photo'] ?? 0][0] ?? '']);
$heroPost = $heroPost ?: get_posts(['post_type' => 'post', 'post_status' => 'publish', 'numberposts' => 1, 'orderby' => 'date', 'order' => 'ASC', 'fields' => 'ids']);
$photo = $heroPost ? (int) get_post_thumbnail_id($heroPost[0]) : 0;
$signupForm = $form(['Newsletter sign-up', 'Subscription Form']);
$signup = !empty($copy['signup']) && $signupForm
    ? anypress_section('Newsletter', anypress_titles($copy['signup'][0], $copy['signup'][1], true) . '<!-- wp:shortcode -->[fluentform id="' . $signupForm . '"]<!-- /wp:shortcode -->', '', '40rem', 'newsletter')
    : '';
// Booking: every service the business's hosts offer, side by side (FluentBooking's team page), not the calendar the
// plugin made for the admin.
$booking = '';
if (defined('FLUENT_BOOKING_VERSION')) {
    $hosts = array_map(static fn ($h) => $sample['people'][$h[0]][0] . ' ' . $sample['people'][$h[0]][1], $sample['bookings']['hosts'] ?? []);
    $calendars = $hosts ? \FluentBooking\App\Models\Calendar::whereIn('title', $hosts)->pluck('id')->toArray() : [];
    $services = $calendars ? \FluentBooking\App\Models\CalendarSlot::whereIn('calendar_id', $calendars)->where('status', 'active')->orderBy('id')->pluck('id')->toArray() : [];
    $booking = $services
        ? anypress_embed(__('Pick a time'), '[fluent_booking_team event_ids="' . implode(',', $services) . '"]', 'book')
        : (function_exists('anypress_booking') ? anypress_booking() : '');
}
$writers = array_map(static fn ($w) => [$w[0] . ' ' . $w[1], $w[2]], $sample['writers'] ?? []);

// The pages, from the template's own sections with the business's words in them.
$content = [];
$content['home'] = $hero($name, $copy['hero'], $buttons($copy['buttons']), $photo)
    . anypress_features($copy['features'][0], $copy['features'][1])
    . (!empty($copy['products']) && defined('FLUENTCART_VERSION') ? anypress_embed($copy['products'], '[fluent_cart_products per_page="6" paginator="numbers"]', 'shop') : '')
    . $booking
    . $latest($latestTitle)
    . $signup
    . (!empty($copy['faq']) ? anypress_faq($copy['faq'][0], $copy['faq'][1]) : '')
    . anypress_call_to_action($copy['cta'][0], $copy['cta'][1], $buttons($copy['cta'][2]));
[$storyTitle, $story, $values] = $copy['about'];
$content['about'] = anypress_story($storyTitle, $story)
    . ($writers ? anypress_features(__('The team'), $writers) : '')
    . anypress_features(__('What we care about'), $values, 'tint')
    . anypress_call_to_action(__('Say hello'), '', [[__('Contact us'), get_permalink($ids['contact'])]]);
$content['contact'] = anypress_features(__('Get in touch'), $copy['contact'], 'tint') . anypress_contact_form();
if (!empty($copy['services'])) {
    [$servicesTitle, , $servicesText, $offers] = $copy['services'];
    $own = !empty($sample['form']['title']) && ($sample['form']['keep'] ?? null) ? $form([$sample['form']['title']]) : 0;
    $content['services'] = anypress_hero($servicesTitle, $servicesText, [[__('Get in touch'), $own ? '#enquire' : get_permalink($ids['contact'])]])
        . anypress_features(__('What we offer'), $offers)
        . ($own ? anypress_section('Enquiry', anypress_titles($sample['form']['title']) . '<!-- wp:shortcode -->[fluentform id="' . $own . '"]<!-- /wp:shortcode -->', 'tint', '44rem', 'enquire') : '')
        . (!empty($copy['faq']) ? '' : anypress_call_to_action($copy['cta'][0], $copy['cta'][1], $buttons($copy['cta'][2])));
}
if (!empty($copy['intake'])) {
    $intake = $form([$copy['intake'][0]]);
    $content['intake'] = anypress_section('Intake', anypress_titles($copy['intake'][0], $copy['intake'][2]) . ($intake ? '<!-- wp:shortcode -->[fluentform id="' . $intake . '"]<!-- /wp:shortcode -->' : ''), '', '44rem');
}

// The sections carry inline styles that kses would strip on a request without an admin.
kses_remove_filters();
foreach ($content as $slug => $blocks) {
    if (!empty($ids[$slug])) {
        wp_update_post(['ID' => $ids[$slug], 'post_content' => $blocks, 'post_status' => 'publish']);
        update_post_meta($ids[$slug], '_anypress_sample', md5((string) get_post_field('post_content', $ids[$slug])));
    }
}
update_post_meta($ids['blog'], '_anypress_sample', md5((string) get_post_field('post_content', $ids['blog'])));
kses_init();

// The menu: the business's pages in the order a visitor reads them, after the shop where there is one.
$menu = get_posts(['post_type' => 'wp_navigation', 'title' => 'Main menu', 'numberposts' => 1, 'suppress_filters' => true]);
if ($menu) {
    $link = static fn (int $id) => '<!-- wp:navigation-link ' . wp_json_encode(['label' => get_the_title($id), 'type' => 'page', 'id' => $id, 'url' => get_permalink($id), 'kind' => 'post-type'], JSON_UNESCAPED_SLASHES) . ' /-->';
    $items = '';
    $shop = get_page_by_path('shop');
    if ($shop && $shop->post_status === 'publish') {
        $items .= $link((int) $shop->ID);
    }
    if (defined('FLUENT_COMMUNITY_PLUGIN_VERSION')) {
        $items .= '<!-- wp:navigation-link ' . wp_json_encode(['label' => __('Community'), 'url' => anypress_portal_url(), 'kind' => 'custom'], JSON_UNESCAPED_SLASHES) . ' /-->';
    }
    foreach (['services', 'blog', 'about', 'contact'] as $slug) {
        if (!empty($ids[$slug])) {
            $items .= $link($ids[$slug]);
        }
    }
    wp_update_post(['ID' => $menu[0]->ID, 'post_content' => $items]);
    update_post_meta($menu[0]->ID, '_anypress_sample', md5((string) get_post_field('post_content', $menu[0]->ID)));
}
