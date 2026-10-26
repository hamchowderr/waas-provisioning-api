<?php
/**
 * Title: Notice: one short message on a band
 * Slug: anypress/notice
 * Description: A short band with one message in bold and a link, such as holiday hours, a delivery cut-off or an announcement. Use at the top of a page and take it down when it no longer applies.
 * Categories: anypress/blocks-calls-to-action, text, call-to-action
 * Keywords: notice, alert, announcement, holiday hours, banner, message
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Notice"},"align":"full","className":"is-style-section-second-brand","style":{"spacing":{"padding":{"top":"var:preset|spacing|small","bottom":"var:preset|spacing|small"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"60rem"}} -->
<section class="wp-block-group alignfull is-style-section-second-brand" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--small);padding-bottom:var(--wp--preset--spacing--small)"><!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center"><strong><?php esc_html_e( 'Closed 24 to 26 December.', 'anypress' ); ?></strong> <?php esc_html_e( 'Orders placed after noon on the 23rd go out on the 27th.', 'anypress' ); ?> <a href="#"><?php esc_html_e( 'See holiday hours', 'anypress' ); ?></a></p>
<!-- /wp:paragraph --></section>
<!-- /wp:group -->
