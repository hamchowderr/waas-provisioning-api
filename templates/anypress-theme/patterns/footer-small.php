<?php
/**
 * Title: Footer: one line
 * Slug: anypress/footer-small
 * Description: A small one-line footer: the site name on the left and a few links on the right. Use for small sites and landing pages.
 * Categories: footer
 * Keywords: footer, small footer, simple, one line
 * Viewport Width: 1400
 * Block Types: core/template-part/footer
 */
?>
<!-- wp:group {"metadata":{"name":"Footer"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|medium","bottom":"var:preset|spacing|medium"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--medium);padding-bottom:var(--wp--preset--spacing--medium)"><!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","verticalAlignment":"center"}} -->
<div class="wp-block-group"><!-- wp:site-title {"level":0,"fontSize":"medium"} /-->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"flex","justifyContent":"right"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size"><a href="#"><?php esc_html_e( 'Contact', 'anypress' ); ?></a></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size"><a href="#"><?php esc_html_e( 'Privacy', 'anypress' ); ?></a></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size"><a href="#"><?php esc_html_e( 'Instagram', 'anypress' ); ?></a></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->
