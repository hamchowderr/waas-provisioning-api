<?php
/**
 * Title: Launch hero: what the product does, and a screenshot
 * Slug: anypress/launch-hero
 * Description: Opening section for a software product, app or startup: a label, a headline that says what the product does for whom, one sentence, two buttons and a wide screenshot under it. Part of the Launch kit (startup and software).
 * Categories: anypress/kit-software
 * Keywords: hero, saas, software, app, startup, product, screenshot, launch
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Hero"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|x-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"72rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--x-large)"><!-- wp:paragraph {"textColor":"primary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-primary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Invoicing for freelancers', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":1,"fontSize":"poster","style":{"typography":{"lineHeight":"0.95"}}} -->
<h1 class="wp-block-heading has-poster-font-size" style="line-height:0.95"><?php esc_html_e( 'Send the invoice. Get paid. Get back to work.', 'anypress' ); ?></h1>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"constrained","contentSize":"40rem","justifyContent":"left"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><?php esc_html_e( 'Tally sends your invoices, chases late payers politely and tells you what to put aside for tax. Free for your first ten clients.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#start"><?php esc_html_e( 'Start free', 'anypress' ); ?></a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#pricing"><?php esc_html_e( 'See pricing', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->

<!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"16/9","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" alt="<?php esc_html_e( 'The app\'s dashboard showing paid and unpaid invoices', 'anypress' ); ?>" style="aspect-ratio:16/9;object-fit:cover"/></figure>
<!-- /wp:image --></section>
<!-- /wp:group -->
