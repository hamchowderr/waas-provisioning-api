<?php
/**
 * Title: Byline masthead: the publication's name between rules
 * Slug: anypress/byline-masthead
 * Description: The top of a blog or magazine home page: the name set very large between two rules, with a line saying what it covers and how often. Part of the Byline kit (blog and magazine).
 * Categories: anypress/kit-magazine
 * Keywords: masthead, blog, magazine, newsletter, publication, title, byline
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Masthead"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|x-large","bottom":"var:preset|spacing|medium"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--x-large);padding-bottom:var(--wp--preset--spacing--medium)"><!-- wp:separator {"className":"is-style-wide"} -->
<hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/>
<!-- /wp:separator -->

<!-- wp:heading {"textAlign":"center","level":1,"fontSize":"poster","style":{"typography":{"lineHeight":"0.9","letterSpacing":"-0.04em"}}} -->
<h1 class="wp-block-heading has-text-align-center has-poster-font-size" style="line-height:0.9;letter-spacing:-0.04em"><?php esc_html_e( 'Field Notes', 'anypress' ); ?></h1>
<!-- /wp:heading -->

<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"textColor":"secondary","fontFamily":"system-sans","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-system-sans-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'Walking, eating and sleeping outdoors', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"textColor":"secondary","fontFamily":"system-sans","fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}}} -->
<p class="has-secondary-color has-text-color has-system-sans-font-family has-small-font-size" style="text-transform:uppercase;letter-spacing:0.08em"><?php esc_html_e( 'New stories every Thursday', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:separator {"className":"is-style-wide"} -->
<hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/>
<!-- /wp:separator --></section>
<!-- /wp:group -->
