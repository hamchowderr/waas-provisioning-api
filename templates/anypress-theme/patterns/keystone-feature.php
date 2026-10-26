<?php
/**
 * Title: Keystone featured home: photo beside the details
 * Slug: anypress/keystone-feature
 * Description: One home in depth: a large photo edge to edge beside a panel with the price, address, the main facts and a button to book a viewing. Part of the Keystone kit.
 * Categories: anypress/kit-real-estate
 * Keywords: featured property, featured listing, home, viewing, keystone
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Featured home"},"align":"full","style":{"spacing":{"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"default"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0"><!-- wp:columns {"align":"full","style":{"spacing":{"blockGap":{"top":"0","left":"0"}}}} -->
<div class="wp-block-columns alignfull"><!-- wp:column {"width":"58%"} -->
<div class="wp-block-column" style="flex-basis:58%"><!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>","dimRatio":0,"overlayColor":"main","isUserOverlayColor":true,"minHeight":38,"minHeightUnit":"rem","layout":{"type":"constrained"}} -->
<div class="wp-block-cover" style="min-height:38rem"><img class="wp-block-cover__image-background" alt="" src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-main-background-color has-background-dim-0 has-background-dim"></span><div class="wp-block-cover__inner-container"></div></div>
<!-- /wp:cover --></div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"center","className":"is-style-section-brand","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large","left":"var:preset|spacing|x-large","right":"var:preset|spacing|x-large"}}}} -->
<div class="wp-block-column is-vertically-aligned-center is-style-section-brand" style="padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large);padding-left:var(--wp--preset--spacing--x-large);padding-right:var(--wp--preset--spacing--x-large)"><!-- wp:paragraph {"textColor":"base","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-base-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Featured home', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:heading {"fontSize":"xx-large"} -->
<h2 class="wp-block-heading has-xx-large-font-size"><?php esc_html_e( 'The Old Rectory, Hudson', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontFamily":"gloock","fontSize":"xx-large"} -->
<p class="has-gloock-font-family has-xx-large-font-size"><?php esc_html_e( '$1,150,000', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( 'An 1840s stone house on two acres, with the original floors, a walled garden and a barn ready to become a studio.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li><?php esc_html_e( '5 bedrooms, 4 bathrooms', 'anypress' ); ?></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><?php esc_html_e( '3,900 sq ft on 2 acres', 'anypress' ); ?></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><?php esc_html_e( 'Ten minutes to the Amtrak station', 'anypress' ); ?></li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#viewing"><?php esc_html_e( 'Book a viewing', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->
