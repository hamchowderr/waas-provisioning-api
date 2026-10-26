<?php
/**
 * Title: Post outline: list post
 * Slug: anypress/post-list
 * Description: A list blog post outline (such as 'seven best' or 'ten ideas'): a short introduction, numbered items each with a photo and a few sentences, and a wrap-up. Replace every item with the real ones.
 * Categories: anypress/posts
 * Keywords: list, listicle, best, top, ideas, roundup, blog post
 * Viewport Width: 1400
 * Block Types: core/post-content
 * Post Types: post
 */
?>
<!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><?php esc_html_e( 'Five walks within an hour of Springfield, all under ten miles, with a good place to eat at the end.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading"><?php esc_html_e( '1. Oak Hill ridge', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/2","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" alt="<?php esc_html_e( 'A path along a grassy ridge', 'anypress' ); ?>" style="aspect-ratio:3/2;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'Eight miles with views over three counties. Muddy in winter; boots, not trainers.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading"><?php esc_html_e( '2. The river loop', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/2","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" alt="<?php esc_html_e( 'A river with trees on both banks', 'anypress' ); ?>" style="aspect-ratio:3/2;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'Flat and easy, five miles, with the Riverside Brewery at the end.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading"><?php esc_html_e( '3. Cedar Falls', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:image {"sizeSlug":"large","linkDestination":"none","aspectRatio":"3/2","scale":"cover"} -->
<figure class="wp-block-image size-large"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-wide.svg' ) ); ?>" alt="<?php esc_html_e( 'A small waterfall in a wood', 'anypress' ); ?>" style="aspect-ratio:3/2;object-fit:cover"/></figure>
<!-- /wp:image -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'Short but steep. Go after rain, when the falls are at their best.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:heading -->
<h2 class="wp-block-heading"><?php esc_html_e( 'Which to pick', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'New to walking? Start with the river loop. Want a day out? Oak Hill, with lunch in the village.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->
