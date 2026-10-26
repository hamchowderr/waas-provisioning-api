<?php
/**
 * Title: Frame hero: who you are, in one big sentence
 * Slug: anypress/frame-hero
 * Description: Opening section for a photographer, designer, illustrator or architect: one very large sentence saying who they are and what they make, with where they work and availability in small type. No photo, so the work below does the talking. Part of the Frame kit (creative portfolio).
 * Categories: anypress/kit-portfolio
 * Keywords: hero, portfolio, photographer, designer, illustrator, architect, statement, frame
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Hero"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|x-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--x-large)"><!-- wp:heading {"level":1,"fontSize":"poster","style":{"typography":{"lineHeight":"0.95"}}} -->
<h1 class="wp-block-heading has-poster-font-size" style="line-height:0.95"><?php esc_html_e( 'Ines Duarte photographs buildings and the people who use them.', 'anypress' ); ?></h1>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|large"}},"layout":{"type":"flex","justifyContent":"left"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Lisbon and Porto', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Taking commissions from March', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><a href="#contact"><?php esc_html_e( 'hello@example.com', 'anypress' ); ?></a></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></section>
<!-- /wp:group -->
