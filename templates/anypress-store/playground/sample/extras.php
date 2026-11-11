<?php
/**
 * The rest of the toolkit: Rank Math set up for the business (setup done, the business in the knowledge graph, a
 * description and focus keyword on every post), an example snippet in FluentSnippets, left off, and a video of the
 * business's kind of work in Fluent Player's library (freely licensed, from Wikimedia Commons, credited in its text).
 */
if (defined('RANK_MATH_VERSION')) {
    update_option('rank_math_wizard_completed', true);
    update_option('rank_math_registration_skip', true);
    $titles = (array) get_option('rank-math-options-titles', []);
    update_option('rank-math-options-titles', array_merge($titles, [
        'knowledgegraph_type' => 'company',
        'knowledgegraph_name' => $sample['business']['name'],
        'website_name' => $sample['business']['name'],
    ]));
    foreach (get_posts(['post_type' => 'post', 'numberposts' => -1]) as $post) {
        update_post_meta($post->ID, 'rank_math_description', wp_trim_words(wp_strip_all_tags($post->post_content), 22));
        // The focus keyword: the title's first words, without punctuation or a dangling "a", "your" or "and".
        $words = array_slice(preg_split('/\s+/', trim(preg_replace('/[^a-z0-9 ]+/', ' ', strtolower(preg_replace('/^Sponsored:\s*/i', '', $post->post_title))))), 0, 4);
        while (count($words) > 1 && in_array(end($words), ['a', 'an', 'the', 'your', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'we', 'is', 'how', 'with'], true)) {
            array_pop($words);
        }
        update_post_meta($post->ID, 'rank_math_focus_keyword', implode(' ', $words));
    }
}

if (defined('FLUENT_SNIPPETS_PLUGIN_VERSION') && !empty($sample['snippet'])) {
    [$name, $code] = $sample['snippet'];
    \FluentSnippets\App\Helpers\Helper::createSnippet([
        'code' => "<?php\n" . $code,
        'meta' => [
            'name' => $name,
            'description' => 'An example: switch it on to see it on the site.',
            'type' => 'PHP',
            'run_at' => 'all',
            'status' => 'draft',
            'tags' => 'example',
        ],
    ]);
}

// Played from Wikimedia Commons, as a pasted link is; each is public domain or CC BY / BY-SA, credited as asked.
$videos = [
    'website' => ['Chopping a tomato salad', 'https://upload.wikimedia.org/wikipedia/commons/4/40/20160722-AMS-LSC-9000_%28Farmers_Market-Food_Demo-Spanish_Tomato_Salad%29.webm', 'USDA Media by Lance Cheung, public domain.'],
    'bookings' => ['What a Swedish massage feels like', 'https://upload.wikimedia.org/wikipedia/commons/9/9f/Massage_Therapy_Swedish_%28Basic_Stroke-_Effleurage%29_%28TESDA%29.webm', 'TESDA Online Program, public domain.'],
    'online-store' => ['How our prints are made', 'https://upload.wikimedia.org/wikipedia/commons/8/83/Tirage_blouse_%28s%C3%A9rigraphie%29.webm', '"Tirage blouse (sérigraphie)" by 4MAPS, CC BY-SA 4.0.'],
    'community' => ['Screen printing, start to finish', 'https://upload.wikimedia.org/wikipedia/commons/8/83/Tirage_blouse_%28s%C3%A9rigraphie%29.webm', '"Tirage blouse (sérigraphie)" by 4MAPS, CC BY-SA 4.0.'],
    'everything' => ['How our prints are made', 'https://upload.wikimedia.org/wikipedia/commons/8/83/Tirage_blouse_%28s%C3%A9rigraphie%29.webm', '"Tirage blouse (sérigraphie)" by 4MAPS, CC BY-SA 4.0.'],
    'highlevel' => ['A day on the roof', 'https://upload.wikimedia.org/wikipedia/commons/0/0e/Workers_on_the_roof.webm', '"Workers on the roof" by Eric Harrison, CC BY-SA 2.0.'],
];
if (defined('FLUENT_PLAYER') && isset($videos[$sample['type']])) {
    [$title, $src, $credit] = $videos[$sample['type']];
    anypress_sample_api('POST', '/fluent-player/v2/media', [
        'settings' => [
            'title' => $title, 'description' => 'Video: ' . $credit . ' From Wikimedia Commons.', 'preset_slug' => 'default', 'src' => $src, 'provider' => 'external', 'viewType' => 'video', 'mediaType' => 'video', 'post_status' => 'publish'],
    ]);
}
