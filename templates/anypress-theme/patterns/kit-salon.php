<?php
/**
 * Title: Home page: Gloss kit, salon and beauty
 * Slug: anypress/kit-salon
 * Description: A complete home page for a hair salon, barber, nail bar or beauty studio in the Gloss kit: a big headline beside a photo, the price list, the team, a gallery and how to book. Apply the Gloss style for the look it was designed with.
 * Categories: anypress/pages
 * Keywords: home, salon, hair, beauty, barber, nails, brows, kit, gloss
 * Viewport Width: 1400
 * Block Types: core/post-content
 * Post Types: page
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Hero"},"align":"full","className":"is-style-section-brand-soft","style":{"spacing":{"padding":{"top":"var:preset|spacing|x-large","bottom":"var:preset|spacing|x-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull is-style-section-brand-soft" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--x-large);padding-bottom:var(--wp--preset--spacing--x-large)"><!-- wp:columns {"verticalAlignment":"center","align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|xx-large","left":"var:preset|spacing|xx-large"}}}} -->
<div class="wp-block-columns alignwide are-vertically-aligned-center"><!-- wp:column {"verticalAlignment":"center","width":"55%"} -->
<div class="wp-block-column is-vertically-aligned-center" style="flex-basis:55%"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Hair, colour and brows on Elm Street', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":1,"fontSize":"xxx-large","style":{"typography":{"lineHeight":"1"}}} -->
<h1 class="wp-block-heading has-xxx-large-font-size" style="line-height:1"><?php esc_html_e( 'Colour that grows out beautifully', 'anypress' ); ?></h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><?php esc_html_e( 'Lived-in colour, precise cuts and an hour that is just for you.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#book"><?php esc_html_e( 'Book online', 'anypress' ); ?></a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#prices"><?php esc_html_e( 'See prices', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/4","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'Make-up brushes in a pot on a pink table', 'anypress' ); ?>" style="aspect-ratio:3/4;object-fit:cover"/></figure>
<!-- /wp:image --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->

<!-- wp:group {"tagName":"section","metadata":{"name":"Prices"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"64rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:heading {"textAlign":"center","fontSize":"xxx-large"} -->
<h2 class="wp-block-heading has-text-align-center has-xxx-large-font-size"><?php esc_html_e( 'Prices', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","textColor":"secondary","fontSize":"medium"} -->
<p class="has-text-align-center has-secondary-color has-text-color has-medium-font-size"><?php esc_html_e( 'Prices depend on hair length and the stylist\'s level. We confirm before we start.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|xx-large","left":"var:preset|spacing|xx-large"}}}} -->
<div class="wp-block-columns alignwide"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-large"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"fontSize":"x-large"} -->
<h2 class="wp-block-heading has-x-large-font-size"><?php esc_html_e( 'Cut and style', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Women\'s cut and finish', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( 'from $65', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Men\'s cut', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( 'from $38', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Blow-dry', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( 'from $40', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:paragraph {"textColor":"secondary","fontSize":"small"} -->
<p class="has-secondary-color has-text-color has-small-font-size"><?php esc_html_e( 'Add curls or waves for $10.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"fontSize":"x-large"} -->
<h2 class="wp-block-heading has-x-large-font-size"><?php esc_html_e( 'Brows and lashes', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Brow shape and tint', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( '$32', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Lash lift', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( '$60', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-large"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"fontSize":"x-large"} -->
<h2 class="wp-block-heading has-x-large-font-size"><?php esc_html_e( 'Colour', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Root colour', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( 'from $75', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Balayage', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( 'from $165', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:paragraph {"textColor":"secondary","fontSize":"small"} -->
<p class="has-secondary-color has-text-color has-small-font-size"><?php esc_html_e( 'Includes toner and a cut.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Gloss', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( '$45', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:paragraph {"textColor":"secondary","fontSize":"small"} -->
<p class="has-secondary-color has-text-color has-small-font-size"><?php esc_html_e( 'Shine and tone between colours.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"fontSize":"x-large"} -->
<h2 class="wp-block-heading has-x-large-font-size"><?php esc_html_e( 'Treatments', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Bond repair', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( '$30', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"className":"is-style-menu-leader","layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group is-style-menu-leader"><!-- wp:heading {"level":3,"fontFamily":"jost","fontSize":"medium","style":{"typography":{"fontWeight":"400"}}} -->
<h3 class="wp-block-heading has-jost-font-family has-medium-font-size" style="font-weight:400"><?php esc_html_e( 'Scalp treatment', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><?php esc_html_e( '$35', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->

<!-- wp:group {"tagName":"section","metadata":{"name":"Team"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:heading {"fontSize":"xx-large"} -->
<h2 class="wp-block-heading has-xx-large-font-size"><?php esc_html_e( 'Who you\'ll sit with', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:group {"align":"wide","style":{"spacing":{"blockGap":"var:preset|spacing|large"}},"layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"15rem"}} -->
<div class="wp-block-group alignwide"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/4","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'Portrait of Nadia', 'anypress' ); ?>" style="aspect-ratio:3/4;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Nadia', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'Owner and colour director. Balayage and grey blending.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/4","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'Portrait of Ollie', 'anypress' ); ?>" style="aspect-ratio:3/4;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Ollie', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'Senior stylist. Short cuts and curly hair.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/4","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'Portrait of Bea', 'anypress' ); ?>" style="aspect-ratio:3/4;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Bea', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'Brows and lashes. Fixes over-plucked brows.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></section>
<!-- /wp:group -->

<!-- wp:group {"tagName":"section","metadata":{"name":"Gallery"},"align":"full","style":{"spacing":{"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"default"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0"><!-- wp:columns {"align":"full","style":{"spacing":{"blockGap":{"top":"0","left":"0"}}}} -->
<div class="wp-block-columns alignfull"><!-- wp:column {"width":"50%"} -->
<div class="wp-block-column" style="flex-basis:50%"><!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>","dimRatio":0,"overlayColor":"main","isUserOverlayColor":true,"minHeight":36,"minHeightUnit":"rem","layout":{"type":"constrained"}} -->
<div class="wp-block-cover" style="min-height:36rem"><img class="wp-block-cover__image-background" alt="" src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-main-background-color has-background-dim-0 has-background-dim"></span><div class="wp-block-cover__inner-container"></div></div>
<!-- /wp:cover --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"style":{"spacing":{"blockGap":"0"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>","dimRatio":0,"overlayColor":"main","isUserOverlayColor":true,"minHeight":18,"minHeightUnit":"rem","layout":{"type":"constrained"}} -->
<div class="wp-block-cover" style="min-height:18rem"><img class="wp-block-cover__image-background" alt="" src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-main-background-color has-background-dim-0 has-background-dim"></span><div class="wp-block-cover__inner-container"></div></div>
<!-- /wp:cover -->

<!-- wp:columns {"isStackedOnMobile":false,"style":{"spacing":{"blockGap":{"top":"0","left":"0"}}}} -->
<div class="wp-block-columns is-not-stacked-on-mobile"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-square.svg' ) ); ?>","dimRatio":0,"overlayColor":"main","isUserOverlayColor":true,"minHeight":18,"minHeightUnit":"rem","layout":{"type":"constrained"}} -->
<div class="wp-block-cover" style="min-height:18rem"><img class="wp-block-cover__image-background" alt="" src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-square.svg' ) ); ?>" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-main-background-color has-background-dim-0 has-background-dim"></span><div class="wp-block-cover__inner-container"></div></div>
<!-- /wp:cover --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-square.svg' ) ); ?>","dimRatio":0,"overlayColor":"main","isUserOverlayColor":true,"minHeight":18,"minHeightUnit":"rem","layout":{"type":"constrained"}} -->
<div class="wp-block-cover" style="min-height:18rem"><img class="wp-block-cover__image-background" alt="" src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-square.svg' ) ); ?>" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-main-background-color has-background-dim-0 has-background-dim"></span><div class="wp-block-cover__inner-container"></div></div>
<!-- /wp:cover --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->

<!-- wp:group {"tagName":"section","metadata":{"name":"Book"},"align":"full","className":"is-style-section-second-brand","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull is-style-section-second-brand" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|xx-large","left":"var:preset|spacing|xx-large"}}}} -->
<div class="wp-block-columns alignwide"><!-- wp:column {"width":"55%"} -->
<div class="wp-block-column" style="flex-basis:55%"><!-- wp:heading {"fontSize":"xxx-large"} -->
<h2 class="wp-block-heading has-xxx-large-font-size"><?php esc_html_e( 'Book in two minutes', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><?php esc_html_e( 'Choose your stylist and a time online, or call us.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#book"><?php esc_html_e( 'Book online', 'anypress' ); ?></a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="tel:5550133"><?php esc_html_e( 'Call 555 0133', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|large"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"level":3,"fontSize":"medium"} -->
<h3 class="wp-block-heading has-medium-font-size"><?php esc_html_e( 'Hours', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'Tuesday to Friday, 9am to 8pm', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'Saturday, 9am to 5pm', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"level":3,"fontSize":"medium"} -->
<h3 class="wp-block-heading has-medium-font-size"><?php esc_html_e( 'Find us', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p><?php esc_html_e( '21 Elm Street, Springfield', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:heading {"level":3,"fontSize":"medium"} -->
<h3 class="wp-block-heading has-medium-font-size"><?php esc_html_e( 'Changing a booking', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'Please give us 24 hours\' notice to move or cancel.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->
