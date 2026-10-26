<?php
/**
 * Title: Parcel hero: product photo beside the collection
 * Slug: anypress/parcel-hero
 * Description: Opening section for an online shop: a large product photo edge to edge beside a panel with the collection name, one sentence and two buttons. Part of the Parcel kit (online shop); use the owner's own product photo.
 * Categories: anypress/kit-shop
 * Keywords: hero, shop, store, products, collection, ecommerce, parcel
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Hero"},"align":"full","style":{"spacing":{"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"default"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0"><!-- wp:columns {"align":"full","style":{"spacing":{"blockGap":{"top":"0","left":"0"}}}} -->
<div class="wp-block-columns alignfull"><!-- wp:column {"width":"55%"} -->
<div class="wp-block-column" style="flex-basis:55%"><!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>","dimRatio":0,"overlayColor":"main","isUserOverlayColor":true,"minHeight":40,"minHeightUnit":"rem","layout":{"type":"constrained"}} -->
<div class="wp-block-cover" style="min-height:40rem"><img class="wp-block-cover__image-background" alt="" src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-main-background-color has-background-dim-0 has-background-dim"></span><div class="wp-block-cover__inner-container"></div></div>
<!-- /wp:cover --></div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"center","className":"is-style-section-tint","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large","left":"var:preset|spacing|x-large","right":"var:preset|spacing|x-large"}}}} -->
<div class="wp-block-column is-vertically-aligned-center is-style-section-tint" style="padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large);padding-left:var(--wp--preset--spacing--x-large);padding-right:var(--wp--preset--spacing--x-large)"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'New this autumn', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":1,"fontSize":"xxx-large"} -->
<h1 class="wp-block-heading has-xxx-large-font-size"><?php esc_html_e( 'Stoneware, thrown by hand in small batches', 'anypress' ); ?></h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( 'Mugs, bowls and vases made in our Asheville studio and fired twice. Every piece is a little different.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#shop"><?php esc_html_e( 'Shop the collection', 'anypress' ); ?></a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#story"><?php esc_html_e( 'How it\'s made', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->
