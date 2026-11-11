<?php
/**
 * The blog, kept up for six months: the business's writers as authors, posts in categories with descriptions and a
 * featured photo each, comment threads with the writer's replies (the newest few waiting for approval), one draft and
 * one post scheduled for next week.
 */
$blog = $sample['blog'];

/** A body in the sample's short form (blank line: paragraph, "## ": heading, "- ": list item) as block markup. */
$blocks = static function (string $text): string {
    $out = '';
    foreach (preg_split('/\n\s*\n/', trim($text)) as $chunk) {
        if (str_starts_with($chunk, '## ')) {
            $out .= "<!-- wp:heading -->\n<h2 class=\"wp-block-heading\">" . esc_html(substr($chunk, 3)) . "</h2>\n<!-- /wp:heading -->\n\n";
        } elseif (str_starts_with($chunk, '- ')) {
            $items = '';
            foreach (explode("\n", $chunk) as $line) {
                $items .= "<!-- wp:list-item -->\n<li>" . esc_html(ltrim(substr($line, 2))) . "</li>\n<!-- /wp:list-item -->\n";
            }
            $out .= "<!-- wp:list -->\n<ul class=\"wp-block-list\">" . $items . "</ul>\n<!-- /wp:list -->\n\n";
        } else {
            $out .= "<!-- wp:paragraph -->\n<p>" . esc_html($chunk) . "</p>\n<!-- /wp:paragraph -->\n\n";
        }
    }
    return trim($out);
};
$excerpt = static fn (string $text) => wp_trim_words(preg_replace('/^(## .*|- .*)$/m', '', $text), 26);

// The writers, as the site's authors.
$writers = [];
foreach ($blog['writers'] as $w => [$first, $last, $bio]) {
    $id = anypress_sample_user([$first, $last, '', '', $bio]);
    if ($id) {
        wp_update_user(['ID' => $id, 'role' => $w === 0 ? 'editor' : 'author', 'description' => $bio]);
        $writers[] = $id;
    }
}
$writers = $writers ?: [1];

$categories = [];
foreach ($blog['categories'] as $name => $about) {
    $term = term_exists($name, 'category') ?: wp_insert_term($name, 'category', ['description' => $about]);
    if (!is_wp_error($term)) {
        $categories[$name] = (int) $term['term_id'];
    }
}

$people = $sample['people'];
$count = count($blog['posts']);
$span = 175;
$posted = [];
foreach ($blog['posts'] as $i => [$title, $category, $writer, , $text]) {
    // Oldest first, a post every week or two, the newest a few days ago.
    $daysAgo = $span - $i * ($span - 3) / max(1, $count - 1);
    $id = wp_insert_post([
        'post_title' => $title,
        'post_content' => $blocks($text),
        'post_excerpt' => $excerpt($text),
        'post_status' => 'publish',
        'post_author' => $writers[$writer] ?? $writers[0],
        'post_date' => get_date_from_gmt(anypress_sample_when($daysAgo, 13 + $i % 4)),
        'post_category' => isset($categories[$category]) ? [$categories[$category]] : [],
        'tags_input' => array_values(array_unique([strtolower($category), str_starts_with($title, 'Sponsored') ? 'sponsored' : ($i % 3 ? 'how to' : 'favourites')])),
        'comment_status' => 'open',
    ]);
    if (!$id || is_wp_error($id)) {
        continue;
    }
    $posted[] = [$id, $daysAgo, $writers[$writer] ?? $writers[0]];
    $photo = anypress_sample_image($sample['type'] . '/' . str_pad((string) $i, 2, '0', STR_PAD_LEFT) . '.webp', $id, $title);
    if ($photo) {
        set_post_thumbnail($id, $photo);
    }
}

// Comment threads: readers on most posts, the writer answering some; the newest few wait for approval.
$comments = $blog['comments'];
$replies = $blog['replies'];
$c = 0;
$pending = 3;
foreach (array_reverse($posted) as $n => [$postId, $daysAgo, $author]) {
    $many = [3, 1, 4, 0, 2, 2, 1, 3][$n % 8];
    for ($k = 0; $k < $many; $k++) {
        $p = $people[($n * 3 + $k * 5) % count($people)];
        $at = max(0.2, $daysAgo - 0.5 - $k * 1.3);
        $waiting = $pending > 0 && $n < 4 && $k === 0;
        $commentId = wp_insert_comment([
            'comment_post_ID' => $postId,
            'comment_author' => $p[0] . ' ' . $p[1],
            'comment_author_email' => anypress_sample_email($p),
            'comment_content' => $comments[$c++ % count($comments)],
            'comment_approved' => $waiting ? 0 : 1,
            'comment_date' => get_date_from_gmt(anypress_sample_when($at, 8 + ($k * 5) % 12)),
            'comment_date_gmt' => anypress_sample_when($at, 8 + ($k * 5) % 12),
        ]);
        if ($waiting) {
            $pending--;
            continue;
        }
        if ($commentId && ($k + $n) % 2 === 0) {
            $writer = get_userdata($author);
            wp_insert_comment([
                'comment_post_ID' => $postId,
                'comment_parent' => $commentId,
                'user_id' => $author,
                'comment_author' => $writer ? $writer->display_name : '',
                'comment_author_email' => $writer ? $writer->user_email : '',
                'comment_content' => $replies[($c + $k) % count($replies)],
                'comment_approved' => 1,
                'comment_date' => get_date_from_gmt(anypress_sample_when(max(0.1, $at - 0.3), 19)),
                'comment_date_gmt' => anypress_sample_when(max(0.1, $at - 0.3), 19),
            ]);
        }
    }
}

// Work in progress: a draft and a post scheduled for next week.
foreach ($blog['drafts'] ?? [] as [$title, $category, $writer, $text]) {
    wp_insert_post([
        'post_title' => $title, 'post_content' => $blocks($text), 'post_status' => 'draft',
        'post_author' => $writers[$writer] ?? $writers[0],
        'post_category' => isset($categories[$category]) ? [$categories[$category]] : [],
    ]);
}
foreach ($blog['scheduled'] ?? [] as $s => [$title, $category, $writer, , $text]) {
    $id = wp_insert_post([
        'post_title' => $title, 'post_content' => $blocks($text), 'post_excerpt' => $excerpt($text), 'post_status' => 'future',
        'post_author' => $writers[$writer] ?? $writers[0],
        'post_date' => get_date_from_gmt(anypress_sample_when(-6 - $s, 13)),
        'post_category' => isset($categories[$category]) ? [$categories[$category]] : [],
    ]);
    $photo = $id ? anypress_sample_image($sample['type'] . "/s$s.webp", $id, $title) : 0;
    if ($photo) {
        set_post_thumbnail($id, $photo);
    }
}
