<?php
/**
 * Title: Still welcome: a few words, set to one side
 * Slug: anypress/still-intro
 * Description: A short welcome in large, light type, set off-centre with plenty of space around it. Part of the Still kit; two or three sentences at most.
 * Categories: anypress/kit-wellness
 * Keywords: intro, welcome, about, statement, still
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Welcome"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|x-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"36rem","justifyContent":"right"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--x-large)"><!-- wp:paragraph {"fontSize":"xx-large","style":{"typography":{"lineHeight":"1.1","fontWeight":"300"}}} -->
<p class="has-xx-large-font-size" style="line-height:1.1;font-weight:300"><?php esc_html_e( 'An hour where nobody needs anything from you.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"textColor":"secondary","fontSize":"medium"} -->
<p class="has-secondary-color has-text-color has-medium-font-size"><?php esc_html_e( 'We keep the rooms warm, the lights low and the phones outside. Treatments are booked with gaps between them, so nobody rushes you in or out.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#book"><?php esc_html_e( 'Book a treatment', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></section>
<!-- /wp:group -->
