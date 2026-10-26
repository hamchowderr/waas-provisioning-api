<?php
/**
 * Title: Author box: who wrote this
 * Slug: anypress/author-box
 * Description: A box at the end of a post with the writer's photo, name, a two-line bio and where to follow them. Use at the end of blog posts and guides; it builds trust in the advice.
 * Categories: text, posts
 * Keywords: author, author box, bio, writer, about the author
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Author"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|large","bottom":"var:preset|spacing|large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"48rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--large);padding-bottom:var(--wp--preset--spacing--large)"><!-- wp:group {"className":"is-style-section-tint","style":{"spacing":{"padding":{"top":"var:preset|spacing|large","bottom":"var:preset|spacing|large","left":"var:preset|spacing|large","right":"var:preset|spacing|large"},"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group is-style-section-tint" style="padding-top:var(--wp--preset--spacing--large);padding-bottom:var(--wp--preset--spacing--large);padding-left:var(--wp--preset--spacing--large);padding-right:var(--wp--preset--spacing--large)"><!-- wp:columns {"verticalAlignment":"center","isStackedOnMobile":false,"style":{"spacing":{"blockGap":{"top":"var:preset|spacing|medium","left":"var:preset|spacing|medium"}}}} -->
<div class="wp-block-columns are-vertically-aligned-center is-not-stacked-on-mobile"><!-- wp:column {"width":"6rem"} -->
<div class="wp-block-column" style="flex-basis:6rem"><!-- wp:image {"width":"6rem","aspectRatio":"1","scale":"cover","sizeSlug":"large","linkDestination":"none","style":{"border":{"radius":"var:preset|border-radius|full"}}} -->
<figure class="wp-block-image size-large is-resized has-custom-border"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-square.svg' ) ); ?>" alt="<?php esc_html_e( 'Portrait of the owner', 'anypress' ); ?>" style="border-radius:var(--wp--preset--border-radius--full);aspect-ratio:1;object-fit:cover;width:6rem;height:auto"/></figure>
<!-- /wp:image --></div>
<!-- /wp:column -->

<!-- wp:column {"verticalAlignment":"center"} -->
<div class="wp-block-column is-vertically-aligned-center"><!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Written by Ana Ortiz', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'Ana has taught yoga in Springfield since 2012 and writes about moving well at any age.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:social-links {"layout":{"type":"flex"}} -->
<ul class="wp-block-social-links"><!-- wp:social-link {"url":"#","service":"instagram"} /-->

<!-- wp:social-link {"url":"#","service":"youtube"} /--></ul>
<!-- /wp:social-links --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></div>
<!-- /wp:group --></section>
<!-- /wp:group -->
