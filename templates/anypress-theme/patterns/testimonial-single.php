<?php
/**
 * Title: One customer review, large
 * Slug: anypress/testimonial-single
 * Description: A single customer review shown large with the customer's name and town. Use one real review instead of a slider of many; leave the section out if the owner has no reviews yet.
 * Categories: testimonials, anypress-proof
 * Keywords: testimonial, review, quote, customer, proof
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Review"},"align":"full","className":"is-style-section-brand-soft","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"50rem"}} -->
<section class="wp-block-group alignfull is-style-section-brand-soft" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:quote {"className":"is-style-plain"} -->
<blockquote class="wp-block-quote is-style-plain"><!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><?php esc_html_e( 'They found a leak two other roofers missed, fixed it the same afternoon and sent photos of every step.', 'anypress' ); ?></p>
<!-- /wp:paragraph --><cite><?php esc_html_e( 'Dana R., Springfield', 'anypress' ); ?></cite></blockquote>
<!-- /wp:quote --></section>
<!-- /wp:group -->
