<?php
/**
 * Title: Rep timetable: the week in a table
 * Slug: anypress/rep-timetable
 * Description: The weekly timetable as a table: days down the side, morning, lunchtime and evening across. Part of the Rep kit; keep it current, or link to the booking system's live timetable.
 * Categories: anypress/kit-fitness
 * Keywords: timetable, schedule, class times, week, rep
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Timetable"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
<div class="wp-block-group"><!-- wp:heading {"fontSize":"xxx-large"} -->
<h2 class="wp-block-heading has-xxx-large-font-size"><?php esc_html_e( 'This week', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#book"><?php esc_html_e( 'Book a class', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->

<!-- wp:table {"hasFixedLayout":false,"className":"is-style-stripes"} -->
<figure class="wp-block-table is-style-stripes"><table><thead><tr><th><?php esc_html_e( '', 'anypress' ); ?></th><th><?php esc_html_e( '6:30am', 'anypress' ); ?></th><th><?php esc_html_e( '12:15pm', 'anypress' ); ?></th><th><?php esc_html_e( '6pm', 'anypress' ); ?></th></tr></thead><tbody><tr><td><?php esc_html_e( 'Mon', 'anypress' ); ?></td><td><?php esc_html_e( 'Strength', 'anypress' ); ?></td><td><?php esc_html_e( 'Conditioning', 'anypress' ); ?></td><td><?php esc_html_e( 'Boxing', 'anypress' ); ?></td></tr><tr><td><?php esc_html_e( 'Tue', 'anypress' ); ?></td><td><?php esc_html_e( 'Conditioning', 'anypress' ); ?></td><td><?php esc_html_e( 'Mobility', 'anypress' ); ?></td><td><?php esc_html_e( 'Strength', 'anypress' ); ?></td></tr><tr><td><?php esc_html_e( 'Wed', 'anypress' ); ?></td><td><?php esc_html_e( 'Strength', 'anypress' ); ?></td><td><?php esc_html_e( 'Conditioning', 'anypress' ); ?></td><td><?php esc_html_e( 'Boxing', 'anypress' ); ?></td></tr><tr><td><?php esc_html_e( 'Thu', 'anypress' ); ?></td><td><?php esc_html_e( 'Conditioning', 'anypress' ); ?></td><td><?php esc_html_e( 'Mobility', 'anypress' ); ?></td><td><?php esc_html_e( 'Strength', 'anypress' ); ?></td></tr><tr><td><?php esc_html_e( 'Fri', 'anypress' ); ?></td><td><?php esc_html_e( 'Strength', 'anypress' ); ?></td><td><?php esc_html_e( 'Conditioning', 'anypress' ); ?></td><td><?php esc_html_e( 'Strength', 'anypress' ); ?></td></tr><tr><td><?php esc_html_e( 'Sat', 'anypress' ); ?></td><td><?php esc_html_e( 'Team workout, 9am', 'anypress' ); ?></td><td><?php esc_html_e( '', 'anypress' ); ?></td><td><?php esc_html_e( '', 'anypress' ); ?></td></tr></tbody></table></figure>
<!-- /wp:table --></section>
<!-- /wp:group -->
