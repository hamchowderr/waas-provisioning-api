<?php
/**
 * Title: Thank you page: after a signup or purchase
 * Slug: anypress/page-thank-you
 * Description: The page people see after they sign up, buy or send a form: a thank you, what happens next in three steps and one next thing to do. Set the form or checkout to send people here.
 * Categories: anypress/pages
 * Keywords: thank you, confirmation, success, after purchase, after signup
 * Viewport Width: 1400
 * Block Types: core/post-content
 * Post Types: page
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Thank you"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"40rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--large)"><!-- wp:heading {"textAlign":"center","level":1,"fontSize":"xxx-large"} -->
<h1 class="wp-block-heading has-text-align-center has-xxx-large-font-size"><?php esc_html_e( 'Thank you, you\'re in', 'anypress' ); ?></h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","fontSize":"large"} -->
<p class="has-text-align-center has-large-font-size"><?php esc_html_e( 'Check your email: we\'ve sent a confirmation and everything you need.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></section>
<!-- /wp:group -->

<!-- wp:group {"tagName":"section","metadata":{"name":"Next"},"align":"full","className":"is-style-section-tint","style":{"spacing":{"padding":{"top":"var:preset|spacing|x-large","bottom":"var:preset|spacing|x-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"40rem"}} -->
<section class="wp-block-group alignfull is-style-section-tint" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--x-large);padding-bottom:var(--wp--preset--spacing--x-large)"><!-- wp:heading {"fontSize":"large"} -->
<h2 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'What happens next', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"level":3,"fontSize":"medium"} -->
<h3 class="wp-block-heading has-medium-font-size"><?php esc_html_e( '1. Check your inbox', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'The email comes from hello@example.com. Look in spam if it isn\'t there in five minutes.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"level":3,"fontSize":"medium"} -->
<h3 class="wp-block-heading has-medium-font-size"><?php esc_html_e( '2. Save the date', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'Your first lesson arrives on Monday morning.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"level":3,"fontSize":"medium"} -->
<h3 class="wp-block-heading has-medium-font-size"><?php esc_html_e( '3. Say hello', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'Reply to the email and tell us what you hope to get out of it.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="/"><?php esc_html_e( 'Back to the home page', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></section>
<!-- /wp:group -->
