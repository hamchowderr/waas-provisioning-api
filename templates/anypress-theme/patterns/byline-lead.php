<?php
/**
 * Title: Byline lead story: the newest post, large
 * Slug: anypress/byline-lead
 * Description: The newest post, large: its photo beside the category, title, excerpt and date. Part of the Byline kit; it updates on its own when a new post is published.
 * Categories: anypress/kit-magazine
 * Keywords: featured post, lead story, latest post, blog, byline
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Lead story"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|medium","bottom":"var:preset|spacing|x-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--medium);padding-bottom:var(--wp--preset--spacing--x-large)"><!-- wp:query {"queryId":21,"query":{"perPage":1,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","inherit":false},"align":"wide","layout":{"type":"default"}} -->
<div class="wp-block-query alignwide"><!-- wp:post-template {"layout":{"type":"default"}} -->
<!-- wp:columns {"verticalAlignment":"center","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|x-large","left":"var:preset|spacing|x-large"}}}} -->
<div class="wp-block-columns are-vertically-aligned-center"><!-- wp:column {"width":"55%"} -->
<div class="wp-block-column" style="flex-basis:55%"><!-- wp:post-featured-image {"isLink":true,"aspectRatio":"4/3"} /--></div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"center"} -->
<div class="wp-block-column is-vertically-aligned-center"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:post-terms {"term":"category","textColor":"primary","fontSize":"small"} /-->

<!-- wp:post-title {"level":2,"isLink":true,"fontSize":"xx-large"} /-->

<!-- wp:post-excerpt {"excerptLength":32,"fontSize":"medium"} /-->

<!-- wp:post-date {"textColor":"secondary","fontSize":"small"} /--></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->
<!-- /wp:post-template -->

<!-- wp:query-no-results -->
<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'Your newest post will appear here, large.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->
<!-- /wp:query-no-results --></div>
<!-- /wp:query --></section>
<!-- /wp:group -->
