<?php
/**
 * Title: Links page (link in bio)
 * Slug: anypress/page-links
 * Description: A one-column page of large buttons for the link in a social media bio: a round photo, the name, one line and a button for each place to go. Keep it to the five or six links that matter.
 * Categories: anypress/pages
 * Keywords: link in bio, links, social media, instagram, tiktok, linktree
 * Viewport Width: 1400
 * Block Types: core/post-content
 * Post Types: page
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Links"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"28rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:image {"width":"8rem","aspectRatio":"1","scale":"cover","sizeSlug":"large","linkDestination":"none","align":"center","style":{"border":{"radius":"var:preset|border-radius|full"}}} -->
<figure class="wp-block-image aligncenter size-large is-resized has-custom-border"><img src="<?php echo esc_url( get_theme_file_uri( 'assets/images/placeholder-square.svg' ) ); ?>" alt="<?php esc_html_e( 'Portrait of the owner', 'anypress' ); ?>" style="border-radius:var(--wp--preset--border-radius--full);aspect-ratio:1;object-fit:cover;width:8rem;height:auto"/></figure>
<!-- /wp:image -->

<!-- wp:heading {"textAlign":"center","level":1,"fontSize":"x-large"} -->
<h1 class="wp-block-heading has-text-align-center has-x-large-font-size"><?php esc_html_e( 'Ana Ortiz', 'anypress' ); ?></h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","textColor":"secondary"} -->
<p class="has-text-align-center has-secondary-color has-text-color"><?php esc_html_e( 'Yoga and pilates in Springfield. Classes every day.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex","orientation":"vertical","justifyContent":"stretch"}} -->
<div class="wp-block-buttons"><!-- wp:button {"style":{"dimensions":{"width":"100%"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#book"><?php esc_html_e( 'Book a class', 'anypress' ); ?></a></div>
<!-- /wp:button -->

<!-- wp:button {"style":{"dimensions":{"width":"100%"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#timetable"><?php esc_html_e( 'This week\'s timetable', 'anypress' ); ?></a></div>
<!-- /wp:button -->

<!-- wp:button {"style":{"dimensions":{"width":"100%"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#vouchers"><?php esc_html_e( 'Gift vouchers', 'anypress' ); ?></a></div>
<!-- /wp:button -->

<!-- wp:button {"style":{"dimensions":{"width":"100%"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#blog"><?php esc_html_e( 'Read the blog', 'anypress' ); ?></a></div>
<!-- /wp:button -->

<!-- wp:button {"style":{"dimensions":{"width":"100%"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#contact"><?php esc_html_e( 'Get in touch', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></section>
<!-- /wp:group -->
