<?php
/**
 * A demo made for one business (the API's prospect demos, docs/prospect-demos.md). anypress.io/try?for=<code> writes
 * what was read from the business's website to ANYPRESS_PROSPECT and runs this part last, after the sample business.
 *
 * Who the demo is for decides what it shows ("route"):
 * - owner, chamber, reseller: the site is theirs. It takes their name, tagline, colours and logo, and the home page
 *   opens with them, what they offer (a price only where their own website prints one) and how to reach them.
 * - seller, affiliate: the site stays the sample business, a site they could make or recommend for their customers,
 *   in their kit.
 * Every page gets a bar saying who the demo was made for. The rest of the sample stays, so every screen still works.
 */
$prospect = json_decode((string) file_get_contents(ANYPRESS_PROSPECT), true);
if (!is_array($prospect) || empty($prospect['company'])) {
    return;
}
$brand = is_array($prospect['brand'] ?? null) ? $prospect['brand'] : [];
$company = (string) $prospect['company'];
$route = (string) ($prospect['route'] ?? 'owner');
$ownSite = in_array($route, ['owner', 'chamber', 'reseller'], true);

/** A colour's relative luminance (WCAG), from #rrggbb. Null for anything else. */
function anypress_prospect_luminance(string $hex): ?float
{
    if (!preg_match('/^#([0-9a-f]{6})$/i', $hex, $m)) {
        return null;
    }
    $channels = array_map(static function (string $pair): float {
        $c = hexdec($pair) / 255;
        return $c <= 0.03928 ? $c / 12.92 : (($c + 0.055) / 1.055) ** 2.4;
    }, str_split($m[1], 2));
    return 0.2126 * $channels[0] + 0.7152 * $channels[1] + 0.0722 * $channels[2];
}

/** Whether white text can sit on the colour (WCAG AA for normal text). */
function anypress_prospect_takes_white(string $hex): bool
{
    $l = anypress_prospect_luminance($hex);
    return $l !== null && 1.05 / ($l + 0.05) >= 4.5;
}

/** A soft tint of the colour, for backgrounds next to it. */
function anypress_prospect_tint(string $hex, float $white = 0.88): string
{
    $out = '#';
    foreach (str_split(substr($hex, 1), 2) as $pair) {
        $out .= str_pad(dechex((int) round(hexdec($pair) + (255 - hexdec($pair)) * $white)), 2, '0', STR_PAD_LEFT);
    }
    return $out;
}

/** Copies an image from the demo's files into the media library. Answers its id, or 0. */
function anypress_prospect_media(?string $url, string $title): int
{
    if (!$url || !preg_match('#^https://#', $url)) {
        return 0;
    }
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';
    $file = download_url($url, 30);
    if (is_wp_error($file)) {
        return 0;
    }
    $id = media_handle_sideload(['name' => sanitize_title($title) . '-' . basename((string) wp_parse_url($url, PHP_URL_PATH)), 'tmp_name' => $file], 0, $title);
    if (is_wp_error($id)) {
        @unlink($file);
        return 0;
    }
    update_post_meta($id, '_wp_attachment_image_alt', $title);
    return (int) $id;
}

/** Whether a logo is light (white or pale on a see-through background), so it needs a dark place to sit. */
function anypress_prospect_light_logo(int $id): bool
{
    $path = get_attached_file($id);
    if (!$path || !function_exists('imagecreatefromstring') || str_ends_with($path, '.svg')) {
        return false;
    }
    $image = @imagecreatefromstring((string) file_get_contents($path));
    if (!$image) {
        return false;
    }
    [$w, $h] = [imagesx($image), imagesy($image)];
    $sum = 0.0;
    $seen = 0;
    for ($x = 0; $x < 24; $x++) {
        for ($y = 0; $y < 24; $y++) {
            $rgba = imagecolorsforindex($image, imagecolorat($image, (int) ($x * $w / 24), (int) ($y * $h / 24)));
            if ($rgba['alpha'] > 100) {
                continue;
            }
            $sum += (0.2126 * $rgba['red'] + 0.7152 * $rgba['green'] + 0.0722 * $rgba['blue']) / 255;
            $seen++;
        }
    }
    return $seen > 0 && $sum / $seen > 0.75;
}

// The kit the demo was planned in, then the business's own brand colour on top (only where white text stays readable
// on it, as the theme's buttons need).
$user = WP_Theme_JSON_Resolver::get_user_global_styles_post_id();
$styles = json_decode((string) get_post_field('post_content', $user), true) ?: [];
$kitFile = !empty($prospect['kit']) && preg_match('/^[a-z0-9-]+$/', (string) $prospect['kit']) ? get_theme_file_path('styles/kit-' . $prospect['kit'] . '.json') : '';
if ($kitFile && is_file($kitFile)) {
    $kit = json_decode((string) file_get_contents($kitFile), true) ?: [];
    $styles = array_replace_recursive($styles, array_intersect_key($kit, array_flip(['settings', 'styles'])));
}
$primary = '';
foreach (['primary', 'accent', 'secondary', 'textPrimary'] as $role) {
    $hex = strtolower((string) ($brand['colors'][$role] ?? ''));
    if ($ownSite && anypress_prospect_takes_white($hex)) {
        $primary = $hex;
        break;
    }
}
if ($primary) {
    $palette = $styles['settings']['color']['palette']['theme'] ?? $styles['settings']['color']['palette'] ?? wp_get_global_settings(['color', 'palette', 'theme']);
    $palette = array_map(static function (array $c) use ($primary): array {
        if ($c['slug'] === 'primary') {
            $c['color'] = $primary;
        } elseif ($c['slug'] === 'primary-accent') {
            $c['color'] = anypress_prospect_tint($primary);
        }
        return $c;
    }, $palette);
    $styles['settings']['color']['palette'] = $palette;
}
// Their own fonts, where the website's are open-licence and the API copied them: headings in the first, text in the
// second (or the first again).
$faces = [];
foreach ($ownSite ? $brand['fontFaces'] ?? [] : [] as $face) {
    if (is_array($face) && !empty($face['family']) && !empty($face['file']) && in_array((int) ($face['weight'] ?? 0), [400, 700], true)) {
        $faces[(string) $face['family']][] = $face;
    }
}
if ($faces) {
    $families = [];
    foreach ($faces as $family => $list) {
        $generic = in_array($list[0]['category'] ?? '', ['serif', 'monospace'], true) ? $list[0]['category'] : 'sans-serif';
        $families[] = [
            'name' => $family,
            'slug' => 'brand-' . sanitize_title($family),
            'fontFamily' => '"' . str_replace('"', '', $family) . '", ' . $generic,
            'fontFace' => array_map(static fn (array $f): array => ['fontFamily' => $family, 'fontWeight' => (string) (int) $f['weight'], 'fontStyle' => 'normal', 'fontDisplay' => 'swap', 'src' => [esc_url_raw((string) $f['file'])]], $list),
        ];
    }
    $styles['settings']['typography']['fontFamilies']['custom'] = $families;
    $heading = 'var:preset|font-family|' . $families[0]['slug'];
    $body = 'var:preset|font-family|' . ($families[1] ?? $families[0])['slug'];
    $styles['styles']['typography']['fontFamily'] = $body;
    $styles['styles']['elements']['heading']['typography']['fontFamily'] = $heading;
    $styles['styles']['blocks']['core/site-title']['typography']['fontFamily'] = $heading;
    foreach (['button', 'link'] as $element) {
        if (isset($styles['styles']['elements'][$element]['typography']['fontFamily'])) {
            $styles['styles']['elements'][$element]['typography']['fontFamily'] = $body;
        }
    }
}
if ($styles) {
    $styles['version'] = WP_Theme_JSON::LATEST_SCHEMA;
    $styles['isGlobalStylesUserThemeJSON'] = true;
    wp_update_post(['ID' => $user, 'post_content' => wp_slash(wp_json_encode($styles))]);
    wp_clean_theme_json_cache();
}

// A bar on every page: who this demo is for. A must-use plugin, so it shows on every page the visitor opens.
$bar = [
    'owner' => sprintf('A demo of a new website for %s, made by AnyPress. Nothing here is live.', $company),
    'chamber' => sprintf('A demo of a new website for %s, made by AnyPress. Nothing here is live.', $company),
    'reseller' => sprintf('A demo of one %s location on AnyPress. Nothing here is live.', $company),
    'seller' => sprintf('A demo for %s: a client site you could build and sell with AnyPress, under your own name.', $company),
    'affiliate' => sprintf('A demo for %s: the kind of site your customers could get with AnyPress, recommended by you.', $company),
][$route] ?? sprintf('A demo made for %s by AnyPress.', $company);
$barPlugin = "<?php\nadd_action('wp_body_open', static function () {\n    echo '<p class=\"anypress-prospect-bar\" style=\"margin:0;padding:.6rem 1rem;text-align:center;font-size:.875rem;background:var(--wp--preset--color--main,#15171c);color:var(--wp--preset--color--base,#fff)\">' . "
    . var_export(esc_html($bar), true) . " . '</p>';\n});\n";
file_put_contents(WPMU_PLUGIN_DIR . '/anypress-prospect-bar.php', $barPlugin);

if (!$ownSite) {
    return;
}

$name = (string) ($brand['name'] ?: $company);
if ($route === 'reseller' && !empty($brand['city'])) {
    $name .= ' ' . $brand['city'];
}
update_option('blogname', $name);
update_option('blogdescription', (string) ($brand['tagline'] ?? ''));
if (defined('FLUENTCART_VERSION')) {
    (new \FluentCart\Api\StoreSettings())->set('store_name', $name);
}

// The logo in the header, unless it is pale (made for a dark header): then the header shows the name, and the logo
// sits on the dark opening section of the home page.
$logo = anypress_prospect_media($brand['logo'] ?? null, $name . ' logo');
$lightLogo = $logo && anypress_prospect_light_logo($logo);
if ($logo && !$lightLogo) {
    update_option('site_logo', $logo);
    set_theme_mod('custom_logo', $logo);
}

$e = static fn (string $text): string => esc_html($text);
$paragraph = static fn (string $text): string => "<!-- wp:paragraph -->\n<p>" . esc_html($text) . "</p>\n<!-- /wp:paragraph -->";
$image = static function (int $id, string $alt, string $width = ''): string {
    $url = $id ? wp_get_attachment_image_url($id, 'large') : '';
    if (!$url) {
        return '';
    }
    $attrs = $width ? '{"id":' . $id . ',"width":"' . $width . '","sizeSlug":"large"}' : '{"id":' . $id . ',"sizeSlug":"large"}';
    return '<!-- wp:image ' . $attrs . ' -->' . "\n" . '<figure class="wp-block-image size-large' . ($width ? ' is-resized' : '') . '"><img src="' . esc_url($url) . '" alt="' . esc_attr($alt) . '" class="wp-image-' . $id . '"' . ($width ? ' style="width:' . $width . '"' : '') . '/></figure>' . "\n<!-- /wp:image -->";
};
$section = static fn (string $color, string $text, string $inner): string => '<!-- wp:group {"align":"full","backgroundColor":"' . $color . '","textColor":"' . $text . '","style":{"spacing":{"padding":{"top":"var:preset|spacing|x-large","bottom":"var:preset|spacing|x-large","left":"var:preset|spacing|medium","right":"var:preset|spacing|medium"}}},"layout":{"type":"constrained"}} -->' . "\n"
    . '<div class="wp-block-group alignfull has-' . $text . '-color has-' . $color . '-background-color has-text-color has-background" style="padding-top:var(--wp--preset--spacing--x-large);padding-right:var(--wp--preset--spacing--medium);padding-bottom:var(--wp--preset--spacing--x-large);padding-left:var(--wp--preset--spacing--medium)">' . $inner . "</div>\n<!-- /wp:group -->";

// The opening: their logo, name, tagline and a few words about them.
$opening = ($lightLogo ? $image($logo, $name . ' logo', '240px') : '')
    . "<!-- wp:heading {\"level\":1} -->\n<h1 class=\"wp-block-heading\">" . $e($name) . "</h1>\n<!-- /wp:heading -->"
    . (!empty($brand['tagline']) ? $paragraph((string) $brand['tagline']) : '')
    . (!empty($brand['about']) ? $paragraph((string) $brand['about']) : '');
// A pale logo sits on the brand colour (white text reads on it) or, without one, on the theme's dark colour.
$blocks = [$lightLogo ? $section($primary ? 'primary' : 'main', 'base', $opening) : $section('primary-accent', 'main', $opening)];

// What they offer, three to a row, each with its picture and a price only where their own website prints one.
$items = array_values(array_filter($brand['items'] ?? [], static fn ($i) => is_array($i) && !empty($i['name'])));
if ($items) {
    $rows = '';
    foreach (array_chunk($items, 3) as $chunk) {
        $columns = '';
        foreach ($chunk as $item) {
            $picture = anypress_prospect_media($item['image'] ?? null, (string) $item['name']);
            $columns .= "<!-- wp:column -->\n<div class=\"wp-block-column\">" . $image($picture, (string) $item['name'])
                . "<!-- wp:heading {\"level\":3} -->\n<h3 class=\"wp-block-heading\">" . $e((string) $item['name']) . "</h3>\n<!-- /wp:heading -->"
                . (!empty($item['description']) ? $paragraph((string) $item['description']) : '')
                . (!empty($item['price']) ? $paragraph((string) $item['price']) : '')
                . "</div>\n<!-- /wp:column -->";
        }
        $rows .= "<!-- wp:columns -->\n<div class=\"wp-block-columns\">" . $columns . "</div>\n<!-- /wp:columns -->";
    }
    $blocks[] = $section('base', 'main', "<!-- wp:heading -->\n<h2 class=\"wp-block-heading\">" . ($route === 'chamber' ? 'Coming up and member benefits' : 'What we offer') . "</h2>\n<!-- /wp:heading -->" . $rows);
}

// Their photos, then how to reach them.
$photos = '';
foreach (array_slice($brand['photos'] ?? [], 0, 3) as $n => $url) {
    $photos .= "<!-- wp:column -->\n<div class=\"wp-block-column\">" . $image(anypress_prospect_media((string) $url, $name . ' photo ' . ($n + 1)), $name) . "</div>\n<!-- /wp:column -->";
}
if ($photos) {
    $blocks[] = $section('base', 'main', "<!-- wp:columns -->\n<div class=\"wp-block-columns\">" . $photos . "</div>\n<!-- /wp:columns -->");
}
$reach = array_filter([(string) ($brand['phone'] ?? ''), (string) ($brand['address'] ?? ''), ...array_map('strval', $brand['hours'] ?? [])]);
if ($reach) {
    $blocks[] = $section('tertiary', 'main', "<!-- wp:heading -->\n<h2 class=\"wp-block-heading\">Visit or call</h2>\n<!-- /wp:heading -->" . implode('', array_map($paragraph, $reach)));
}

$front = (int) get_option('page_on_front');
if ($front) {
    wp_update_post(['ID' => $front, 'post_content' => wp_slash(implode("\n\n", $blocks) . "\n\n" . get_post_field('post_content', $front))]);
}

// Only what their own website has: when we know what it has, the shop, booking, community and blog of the sample
// leave the home page and the menu if their site has none of it. The sample's own opening goes too: theirs replaces it.
$site = $ownSite && is_array($brand['site'] ?? null) ? $brand['site'] : null;
$has = static fn (string $feature): bool => !$site || in_array($feature, (array) ($site['features'] ?? []), true);
if ($site && $front) {
    $drop = static function (array $block) use ($has): bool {
        $name = $block['attrs']['metadata']['name'] ?? '';
        $anchor = $block['attrs']['anchor'] ?? '';
        return $name === 'Hero'
            || ($anchor === 'shop' && !$has('shop'))
            || ($anchor === 'book' && !$has('bookings'))
            || ($name === 'Latest posts' && !$has('blog'));
    };
    $kept = array_filter(parse_blocks((string) get_post_field('post_content', $front)), static fn (array $b): bool => !$drop($b));
    wp_update_post(['ID' => $front, 'post_content' => wp_slash(serialize_blocks(array_values($kept)))]);
}
// No shop on their site: the header's product search, account button and cart go too (every page, so a must-use plugin).
if ($site && !$has('shop')) {
    file_put_contents(WPMU_PLUGIN_DIR . '/anypress-prospect-no-shop.php', "<?php\nadd_filter('render_block', static function (\$html, \$block) {\n    return in_array(\$block['blockName'], ['fluent-cart/fluent-products-search-bar', 'fluent-cart/customer-dashboard-button', 'fluent-cart/mini-cart'], true) ? '' : \$html;\n}, 10, 2);\n");
}
$menu = $site ? get_posts(['post_type' => 'wp_navigation', 'title' => 'Main menu', 'numberposts' => 1, 'suppress_filters' => true]) : [];
if ($menu) {
    $shopPage = get_page_by_path('shop');
    $blogPage = (int) get_option('page_for_posts');
    $links = array_filter(parse_blocks((string) $menu[0]->post_content), static function (array $b) use ($has, $shopPage, $blogPage): bool {
        $id = (int) ($b['attrs']['id'] ?? 0);
        return !(($shopPage && $id === (int) $shopPage->ID && !$has('shop'))
            || ($blogPage && $id === $blogPage && !$has('blog'))
            || (($b['attrs']['kind'] ?? '') === 'custom' && function_exists('anypress_portal_url') && ($b['attrs']['url'] ?? '') === anypress_portal_url() && !$has('members')));
    });
    wp_update_post(['ID' => $menu[0]->ID, 'post_content' => wp_slash(serialize_blocks(array_values($links)))]);
}

// Their shop: what they sell, at the prices their website prints, in front of the sample catalogue (which goes to
// draft, so the shop shows only theirs). Items without a printed price stay on the home page only.
if ($ownSite && $has('shop') && defined('FLUENTCART_VERSION') && class_exists('\\FluentCart\\App\\Services\\BulkProductInsertService')) {
    $made = [];
    foreach ($items as $i => $item) {
        $cents = preg_match('/(\d[\d,]*)(?:\.(\d{1,2}))?/', (string) ($item['price'] ?? ''), $m) ? (int) str_replace(',', '', $m[1]) * 100 + (int) str_pad($m[2] ?? '0', 2, '0') : 0;
        if ($cents <= 0) {
            continue;
        }
        $result = (new \FluentCart\App\Services\BulkProductInsertService())->insertChunk([[
            '_cid' => 'prospect' . $i,
            'post_title' => (string) $item['name'],
            'post_excerpt' => (string) ($item['description'] ?? ''),
            'post_content' => (string) ($item['description'] ?? ''),
            'post_status' => 'published',
            'detail' => ['fulfillment_type' => 'physical', 'variation_type' => 'simple'],
            'variants' => [['item_price' => $cents, 'other_info' => ['payment_type' => 'onetime']]],
        ]]);
        $id = (int) ($result['created'][0]['id'] ?? 0);
        $picture = $id ? anypress_prospect_media($item['image'] ?? null, (string) $item['name']) : 0;
        if ($picture) {
            set_post_thumbnail($id, $picture);
        }
        if ($id) {
            $made[] = $id;
        }
    }
    if ($made) {
        foreach (get_posts(['post_type' => 'fluent-products', 'numberposts' => -1, 'fields' => 'ids', 'post_status' => 'publish', 'exclude' => $made]) as $sampleProduct) {
            wp_update_post(['ID' => $sampleProduct, 'post_status' => 'draft']);
        }
        // The sample's categories (clothing and the like) would only confuse the shop's filter.
        foreach (get_terms(['taxonomy' => 'product-categories', 'hide_empty' => false, 'fields' => 'ids']) as $term) {
            wp_delete_term((int) $term, 'product-categories');
        }
    }
}
