<?php
/**
 * The rest of the toolkit: Rank Math set up for the business (setup done, the business in the knowledge graph, a
 * description and focus keyword on every post), and an example snippet in FluentSnippets, left off.
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
