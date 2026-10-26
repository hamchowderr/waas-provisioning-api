<?php
/**
 * Title: Parcel categories: three collections with photos
 * Slug: anypress/parcel-categories
 * Description: Three collections as tall photos with the name and number of pieces under each, and a link to everything. Part of the Parcel kit; link each to its collection page.
 * Categories: anypress/kit-shop
 * Keywords: categories, collections, shop, departments, parcel
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Categories"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group"><!-- wp:heading {"fontSize":"xx-large"} -->
<h2 class="wp-block-heading has-xx-large-font-size"><?php esc_html_e( 'Shop by collection', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><a href="#shop"><?php esc_html_e( 'See everything', 'anypress' ); ?></a></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"align":"wide","style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"16rem"}} -->
<div class="wp-block-group alignwide"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"4/5","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'Three clay cups on a shelf', 'anypress' ); ?>" style="aspect-ratio:4/5;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group"><!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Cups and mugs', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( '14 pieces', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"4/5","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'A small vase with a hole through the middle', 'anypress' ); ?>" style="aspect-ratio:4/5;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group"><!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Vases', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( '9 pieces', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"4/5","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'A glazed blue bottle on a wooden table', 'anypress' ); ?>" style="aspect-ratio:4/5;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group"><!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Bottles', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( '6 pieces', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></section>
<!-- /wp:group -->
