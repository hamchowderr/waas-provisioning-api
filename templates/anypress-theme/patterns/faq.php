<?php
/**
 * Title: Questions and answers
 * Slug: anypress/faq
 * Description: A heading and questions that open to show their answers. Use for the questions customers really ask (prices, areas served, how booking works). Each answer stays short.
 * Categories: anypress/blocks-contact, text
 * Keywords: faq, questions, answers, help
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Questions"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"44rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:heading -->
<h2 class="wp-block-heading"><?php esc_html_e( 'Questions people ask', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:details -->
<details class="wp-block-details"><summary><?php esc_html_e( 'Do you charge for a quote?', 'anypress' ); ?></summary><!-- wp:paragraph -->
<p><?php esc_html_e( 'No. Quotes are free and come with photos of what we found.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></details>
<!-- /wp:details -->

<!-- wp:details -->
<details class="wp-block-details"><summary><?php esc_html_e( 'Which areas do you cover?', 'anypress' ); ?></summary><!-- wp:paragraph -->
<p><?php esc_html_e( 'Springfield and every town within 30 miles.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></details>
<!-- /wp:details -->

<!-- wp:details -->
<details class="wp-block-details"><summary><?php esc_html_e( 'Are you insured?', 'anypress' ); ?></summary><!-- wp:paragraph -->
<p><?php esc_html_e( 'Yes, fully licensed and insured. We send certificates on request.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></details>
<!-- /wp:details --></section>
<!-- /wp:group -->
