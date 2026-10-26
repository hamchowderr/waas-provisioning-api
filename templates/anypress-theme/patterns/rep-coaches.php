<?php
/**
 * Title: Rep coaches: who will coach you
 * Slug: anypress/rep-coaches
 * Description: Two coaches side by side, each with a photo, name and what they are known for. Part of the Rep kit; use the real coaches.
 * Categories: anypress/kit-fitness
 * Keywords: coaches, trainers, team, staff, rep
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Coaches"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:heading {"fontSize":"xxx-large"} -->
<h2 class="wp-block-heading has-xxx-large-font-size"><?php esc_html_e( 'Your coaches', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|x-large","left":"var:preset|spacing|x-large"}}}} -->
<div class="wp-block-columns alignwide"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/2","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" alt="<?php esc_html_e( 'Marcus coaching a class', 'anypress' ); ?>" style="aspect-ratio:3/2;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:heading {"level":3,"fontSize":"xx-large"} -->
<h3 class="wp-block-heading has-xx-large-font-size"><?php esc_html_e( 'Marcus', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( 'Head coach. Former rugby player, now teaches beginners to deadlift without fear.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/2","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" alt="<?php esc_html_e( 'Priya coaching a class', 'anypress' ); ?>" style="aspect-ratio:3/2;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:heading {"level":3,"fontSize":"xx-large"} -->
<h3 class="wp-block-heading has-xx-large-font-size"><?php esc_html_e( 'Priya', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( 'Boxing and conditioning. Twelve years in the ring and endlessly patient.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->
