<?php
/**
 * Title: Follow us: social links on a band
 * Slug: anypress/social-follow
 * Description: A band asking visitors to follow the business on social media, with one line about what they post and the social icons. Use near the end of a page; link only the accounts the business keeps up.
 * Categories: anypress/blocks-calls-to-action, call-to-action, text
 * Keywords: social media, follow, instagram, facebook, tiktok, social links
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Follow"},"align":"full","className":"is-style-section-brand-soft","style":{"spacing":{"padding":{"top":"var:preset|spacing|x-large","bottom":"var:preset|spacing|x-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"40rem"}} -->
<section class="wp-block-group alignfull is-style-section-brand-soft" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--x-large);padding-bottom:var(--wp--preset--spacing--x-large)"><!-- wp:heading {"textAlign":"center","fontSize":"x-large"} -->
<h2 class="wp-block-heading has-text-align-center has-x-large-font-size"><?php esc_html_e( 'Follow along', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center"><?php esc_html_e( 'New work, behind the scenes and the odd offer, a few times a week.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:social-links {"layout":{"type":"flex","justifyContent":"center"}} -->
<ul class="wp-block-social-links"><!-- wp:social-link {"url":"#","service":"instagram"} /-->

<!-- wp:social-link {"url":"#","service":"facebook"} /-->

<!-- wp:social-link {"url":"#","service":"tiktok"} /-->

<!-- wp:social-link {"url":"#","service":"youtube"} /--></ul>
<!-- /wp:social-links --></section>
<!-- /wp:group -->
