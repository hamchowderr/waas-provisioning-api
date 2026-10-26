<?php
/**
 * Title: Home page: Frame kit, creative portfolio
 * Slug: anypress/kit-portfolio
 * Description: A complete home page for a photographer, designer, illustrator, architect or artist in the Frame kit: one big sentence, selected work in staggered columns, one project in depth, clients and a huge email address. Apply the Frame style for the look it was designed with.
 * Categories: anypress/pages
 * Keywords: home, portfolio, photographer, designer, illustrator, architect, artist, creative, kit, frame
 * Viewport Width: 1400
 * Block Types: core/post-content
 * Post Types: page
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

<!-- wp:group {"tagName":"section","metadata":{"name":"Work"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|x-large","left":"var:preset|spacing|x-large"}}}} -->
<div class="wp-block-columns alignwide"><!-- wp:column {"width":"55%"} -->
<div class="wp-block-column" style="flex-basis:55%"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|xx-large"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"4/5","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'A spiral staircase seen from above', 'anypress' ); ?>" style="aspect-ratio:4/5;object-fit:cover"/><figcaption class="wp-element-caption"><?php esc_html_e( '01 — Spiral stair, Casa Moreira, Porto, 2025', 'anypress' ); ?></figcaption></figure>
<!-- /wp:image -->

<!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"4/3","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" alt="<?php esc_html_e( 'A white outdoor stair against a grey wall', 'anypress' ); ?>" style="aspect-ratio:4/3;object-fit:cover"/><figcaption class="wp-element-caption"><?php esc_html_e( '03 — Fire stair, Marvila studios, 2024', 'anypress' ); ?></figcaption></figure>
<!-- /wp:image --></div>
<!-- /wp:group --></div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"bottom"} -->
<div class="wp-block-column is-vertically-aligned-bottom"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|xx-large"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/4","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'A blue painted building with white windows', 'anypress' ); ?>" style="aspect-ratio:3/4;object-fit:cover"/><figcaption class="wp-element-caption"><?php esc_html_e( '02 — Azul, social housing in Setúbal, 2025', 'anypress' ); ?></figcaption></figure>
<!-- /wp:image -->

<!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/4","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-tall.svg' ) ); ?>" alt="<?php esc_html_e( 'A curving glass tower under a blue sky', 'anypress' ); ?>" style="aspect-ratio:3/4;object-fit:cover"/><figcaption class="wp-element-caption"><?php esc_html_e( '04 — Tower One, for Atelier Sul, 2023', 'anypress' ); ?></figcaption></figure>
<!-- /wp:image --></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->

<!-- wp:cover {"url":"<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>","dimRatio":0,"overlayColor":"main","isUserOverlayColor":true,"minHeight":80,"minHeightUnit":"vh","contentPosition":"bottom left","align":"full","metadata":{"name":"Project photo"},"style":{"spacing":{"padding":{"top":"var:preset|spacing|large","bottom":"var:preset|spacing|large","left":"var:preset|spacing|medium","right":"var:preset|spacing|medium"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<div class="wp-block-cover alignfull has-custom-content-position is-position-bottom-left" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--large);padding-bottom:var(--wp--preset--spacing--large);padding-left:var(--wp--preset--spacing--medium);padding-right:var(--wp--preset--spacing--medium);min-height:80vh"><img class="wp-block-cover__image-background" alt="" src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-main-background-color has-background-dim-0 has-background-dim"></span><div class="wp-block-cover__inner-container"></div></div>
<!-- /wp:cover -->

<!-- wp:group {"tagName":"section","metadata":{"name":"Project details"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|xx-large","left":"var:preset|spacing|xx-large"}}}} -->
<div class="wp-block-columns alignwide"><!-- wp:column {"width":"30%"} -->
<div class="wp-block-column" style="flex-basis:30%"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Client', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'Atelier Sul', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Year', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p><?php esc_html_e( '2023', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Role', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'Photography, 3 days on site', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Used in', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'Competition entry, book', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:heading {"fontSize":"xxx-large"} -->
<h2 class="wp-block-heading has-xxx-large-font-size"><?php esc_html_e( 'Tower One', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><?php esc_html_e( 'A glass tower that changes colour with the weather. The architects wanted it shown on grey days as well as blue ones, so we shot over three weeks and chose the light, not the angle.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->

<!-- wp:group {"tagName":"section","metadata":{"name":"Clients"},"align":"full","className":"is-style-section-tint","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull is-style-section-tint" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|large","left":"var:preset|spacing|large"}}}} -->
<div class="wp-block-columns alignwide"><!-- wp:column {"width":"25%"} -->
<div class="wp-block-column" style="flex-basis:25%"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Selected clients', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"align":"wide","style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"grid","columnCount":2,"minimumColumnWidth":"14rem"}} -->
<div class="wp-block-group alignwide"><!-- wp:paragraph {"fontFamily":"bricolage-grotesque","fontSize":"x-large","style":{"typography":{"lineHeight":"1.1","fontWeight":"600"}}} -->
<p class="has-bricolage-grotesque-font-family has-x-large-font-size" style="line-height:1.1;font-weight:600"><?php esc_html_e( 'Atelier Sul', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontFamily":"bricolage-grotesque","fontSize":"x-large","style":{"typography":{"lineHeight":"1.1","fontWeight":"600"}}} -->
<p class="has-bricolage-grotesque-font-family has-x-large-font-size" style="line-height:1.1;font-weight:600"><?php esc_html_e( 'Casa Moreira', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontFamily":"bricolage-grotesque","fontSize":"x-large","style":{"typography":{"lineHeight":"1.1","fontWeight":"600"}}} -->
<p class="has-bricolage-grotesque-font-family has-x-large-font-size" style="line-height:1.1;font-weight:600"><?php esc_html_e( 'Revista Linha', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontFamily":"bricolage-grotesque","fontSize":"x-large","style":{"typography":{"lineHeight":"1.1","fontWeight":"600"}}} -->
<p class="has-bricolage-grotesque-font-family has-x-large-font-size" style="line-height:1.1;font-weight:600"><?php esc_html_e( 'Norte Weekly', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontFamily":"bricolage-grotesque","fontSize":"x-large","style":{"typography":{"lineHeight":"1.1","fontWeight":"600"}}} -->
<p class="has-bricolage-grotesque-font-family has-x-large-font-size" style="line-height:1.1;font-weight:600"><?php esc_html_e( 'Studio Ferro', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontFamily":"bricolage-grotesque","fontSize":"x-large","style":{"typography":{"lineHeight":"1.1","fontWeight":"600"}}} -->
<p class="has-bricolage-grotesque-font-family has-x-large-font-size" style="line-height:1.1;font-weight:600"><?php esc_html_e( 'Câmara de Vila Nova', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontFamily":"bricolage-grotesque","fontSize":"x-large","style":{"typography":{"lineHeight":"1.1","fontWeight":"600"}}} -->
<p class="has-bricolage-grotesque-font-family has-x-large-font-size" style="line-height:1.1;font-weight:600"><?php esc_html_e( 'Oficina Azul', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontFamily":"bricolage-grotesque","fontSize":"x-large","style":{"typography":{"lineHeight":"1.1","fontWeight":"600"}}} -->
<p class="has-bricolage-grotesque-font-family has-x-large-font-size" style="line-height:1.1;font-weight:600"><?php esc_html_e( 'Lisbon Design Week', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->

<!-- wp:group {"tagName":"section","metadata":{"name":"Contact"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Commissions, prints and talks', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"fontFamily":"bricolage-grotesque","fontSize":"poster","style":{"typography":{"lineHeight":"1","fontWeight":"700","letterSpacing":"-0.04em"}}} -->
<p class="has-bricolage-grotesque-font-family has-poster-font-size" style="line-height:1;font-weight:700;letter-spacing:-0.04em"><a href="mailto:hello@example.com"><?php esc_html_e( 'hello@example.com', 'anypress' ); ?></a></p>
<!-- /wp:paragraph -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|large"}},"layout":{"type":"flex","justifyContent":"left"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Instagram', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Behance', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"textColor":"secondary","fontFamily":"monospace","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-monospace-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Linkedin', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></section>
<!-- /wp:group -->
