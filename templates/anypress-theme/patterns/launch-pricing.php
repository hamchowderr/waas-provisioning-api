<?php
/**
 * Title: Launch pricing: free, pro and team
 * Slug: anypress/launch-pricing
 * Description: Three plans side by side with the monthly price, who each is for, what it includes and a button; the plan most people choose is on the dark style. Part of the Launch kit; match it to the real plans.
 * Categories: anypress/kit-software
 * Keywords: pricing, plans, subscription, free plan, saas, launch
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Pricing"},"align":"full","className":"is-style-section-tint","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull is-style-section-tint" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:heading {"textAlign":"center","fontSize":"xxx-large"} -->
<h2 class="wp-block-heading has-text-align-center has-xxx-large-font-size"><?php esc_html_e( 'Simple pricing', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","textColor":"secondary","fontSize":"medium"} -->
<p class="has-text-align-center has-secondary-color has-text-color has-medium-font-size"><?php esc_html_e( 'Every plan has a 30-day free trial. No card needed to start.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:group {"align":"wide","style":{"spacing":{"blockGap":"var:preset|spacing|medium"}},"layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"16rem"}} -->
<div class="wp-block-group alignwide"><!-- wp:group {"className":"is-style-section-card","style":{"spacing":{"padding":{"top":"var:preset|spacing|large","bottom":"var:preset|spacing|large","left":"var:preset|spacing|large","right":"var:preset|spacing|large"},"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group is-style-section-card" style="padding-top:var(--wp--preset--spacing--large);padding-bottom:var(--wp--preset--spacing--large);padding-left:var(--wp--preset--spacing--large);padding-right:var(--wp--preset--spacing--large)"><!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Free', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"flex","justifyContent":"left","verticalAlignment":"bottom"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"fontFamily":"schibsted-grotesk","fontSize":"xxx-large","style":{"typography":{"lineHeight":"1","fontWeight":"800"}}} -->
<p class="has-schibsted-grotesk-font-family has-xxx-large-font-size" style="line-height:1;font-weight:800"><?php esc_html_e( '$0', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'a month', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'For your first clients.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li><?php esc_html_e( 'Up to 10 clients', 'anypress' ); ?></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><?php esc_html_e( 'Card and bank payments', 'anypress' ); ?></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><?php esc_html_e( 'Reminders', 'anypress' ); ?></li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#start"><?php esc_html_e( 'Start free', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->

<!-- wp:group {"className":"is-style-section-dark","style":{"spacing":{"padding":{"top":"var:preset|spacing|large","bottom":"var:preset|spacing|large","left":"var:preset|spacing|large","right":"var:preset|spacing|large"},"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group is-style-section-dark" style="padding-top:var(--wp--preset--spacing--large);padding-bottom:var(--wp--preset--spacing--large);padding-left:var(--wp--preset--spacing--large);padding-right:var(--wp--preset--spacing--large)"><!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Pro', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"flex","justifyContent":"left","verticalAlignment":"bottom"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"fontFamily":"schibsted-grotesk","fontSize":"xxx-large","style":{"typography":{"lineHeight":"1","fontWeight":"800"}}} -->
<p class="has-schibsted-grotesk-font-family has-xxx-large-font-size" style="line-height:1;font-weight:800"><?php esc_html_e( '$12', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'a month', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:paragraph {"textColor":"main-accent"} -->
<p class="has-main-accent-color has-text-color"><?php esc_html_e( 'For full-time freelancers.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li><?php esc_html_e( 'Unlimited clients', 'anypress' ); ?></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><?php esc_html_e( 'Tax set aside', 'anypress' ); ?></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><?php esc_html_e( 'Bank matching', 'anypress' ); ?></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><?php esc_html_e( 'Your own domain on invoices', 'anypress' ); ?></li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#start"><?php esc_html_e( 'Start a free trial', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->

<!-- wp:group {"className":"is-style-section-card","style":{"spacing":{"padding":{"top":"var:preset|spacing|large","bottom":"var:preset|spacing|large","left":"var:preset|spacing|large","right":"var:preset|spacing|large"},"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group is-style-section-card" style="padding-top:var(--wp--preset--spacing--large);padding-bottom:var(--wp--preset--spacing--large);padding-left:var(--wp--preset--spacing--large);padding-right:var(--wp--preset--spacing--large)"><!-- wp:heading {"level":3,"fontSize":"large"} -->
<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Team', 'anypress' ); ?></h3>
<!-- /wp:heading -->

<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|x-small"}},"layout":{"type":"flex","justifyContent":"left","verticalAlignment":"bottom"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"fontFamily":"schibsted-grotesk","fontSize":"xxx-large","style":{"typography":{"lineHeight":"1","fontWeight":"800"}}} -->
<p class="has-schibsted-grotesk-font-family has-xxx-large-font-size" style="line-height:1;font-weight:800"><?php esc_html_e( '$29', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p><?php esc_html_e( 'a month', 'anypress' ); ?></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:paragraph {"textColor":"secondary"} -->
<p class="has-secondary-color has-text-color"><?php esc_html_e( 'For studios of up to ten.', 'anypress' ); ?></p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li><?php esc_html_e( 'Everything in Pro', 'anypress' ); ?></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><?php esc_html_e( 'Up to 10 people', 'anypress' ); ?></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li><?php esc_html_e( 'Shared clients and approvals', 'anypress' ); ?></li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#start"><?php esc_html_e( 'Start a free trial', 'anypress' ); ?></a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group --></div>
<!-- /wp:group --></section>
<!-- /wp:group -->
