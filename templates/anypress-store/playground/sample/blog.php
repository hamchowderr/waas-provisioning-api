<?php
/** Blog posts in three categories, dated over the last six weeks, two with a visitor's comment. */
$authors = [1];
foreach ($sample['posts'] as $i => [$title, $category, $text]) {
    $term = term_exists($category, 'category') ?: wp_insert_term($category, 'category');
    $blocks = '';
    foreach (explode("\n\n", $text) as $paragraph) {
        $blocks .= "<!-- wp:paragraph -->\n<p>" . esc_html($paragraph) . "</p>\n<!-- /wp:paragraph -->\n\n";
    }
    $id = wp_insert_post([
        'post_title' => $title,
        'post_content' => trim($blocks),
        'post_excerpt' => wp_trim_words($text, 24),
        'post_status' => 'publish',
        'post_date' => anypress_sample_when(3 + $i * 7, 9 + $i),
        'post_category' => is_wp_error($term) ? [] : [(int) $term['term_id']],
        'tags_input' => [strtolower($category), $i % 2 ? 'how to' : 'news'],
        'comment_status' => 'open',
    ]);
    if ($id && $i < 2) {
        $person = $sample['people'][$i + 4];
        wp_insert_comment([
            'comment_post_ID' => $id,
            'comment_author' => $person[0] . ' ' . $person[1],
            'comment_author_email' => anypress_sample_email($person),
            'comment_content' => ['This was exactly what I needed, thank you!', 'Really clear. Sharing this with a friend.'][$i],
            'comment_approved' => 1,
            'comment_date_gmt' => anypress_sample_when(1 + $i * 7, 18),
        ]);
    }
}
