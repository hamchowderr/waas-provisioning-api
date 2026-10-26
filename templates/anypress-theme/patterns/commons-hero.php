<?php
/**
 * Title: Commons hero: who you are and how to join
 * Slug: anypress/commons-hero
 * Description: Opening section for a chamber of commerce, association, club or church: a photo of members together, who the group is for and two buttons (join, and the next events). Part of the Commons kit.
 * Categories: anypress/kit-community
 * Keywords: hero, chamber of commerce, association, club, church, nonprofit, membership, commons
 * Viewport Width: 1400
 */
?>
<!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>","dimRatio":60,"overlayColor":"main","isUserOverlayColor":true,"minHeight":85,"minHeightUnit":"vh","contentPosition":"bottom left","align":"full","metadata":{"name":"Hero"},"style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|x-large","left":"var:preset|spacing|medium","right":"var:preset|spacing|medium"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<div class="wp-block-cover alignfull has-custom-content-position is-position-bottom-left" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--x-large);padding-left:var(--wp--preset--spacing--medium);padding-right:var(--wp--preset--spacing--medium);min-height:85vh"><img class="wp-block-cover__image-background" alt="" src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-main-background-color has-background-dim-60 has-background-dim"></span><div class="wp-block-cover__inner-container"><!-- wp:group {"textColor":"base","style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"constrained","contentSize":"52rem","justifyContent":"left"}} -->
<div class="wp-block-group has-base-color has-text-color"><!-- wp:heading {"level":1,"fontSize":"poster","style":{"typography":{"lineHeight":"0.95"}}} -->
<h1 class="wp-block-heading has-poster-font-size" style="line-height:0.95"><?php esc_html_e( 'Springfield Chamber of Commerce', 'anypress' ); ?></h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><?php esc_html_e( 'Four hundred local businesses that help each other grow. Meet them at our breakfasts, find them in our directory, and add your voice to the town\'s plans.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#join"><?php esc_html_e( 'Become a member', 'anypress' ); ?></a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#events"><?php esc_html_e( 'See upcoming events', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group --></div></div>
<!-- /wp:cover -->
