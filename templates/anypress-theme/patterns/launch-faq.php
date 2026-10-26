<?php
/**
 * Title: Launch questions: what people ask before signing up
 * Slug: anypress/launch-faq
 * Description: Common questions that open one at a time, beside a heading and a link to support. Part of the Launch kit; answer the real questions from sales and support.
 * Categories: anypress/kit-software
 * Keywords: faq, questions, answers, support, launch
 * Viewport Width: 1400
 */
?>
<!-- wp:group {"tagName":"section","metadata":{"name":"Questions"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)"><!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|xx-large","left":"var:preset|spacing|xx-large"}}}} -->
<div class="wp-block-columns alignwide"><!-- wp:column {"width":"35%"} -->
<div class="wp-block-column" style="flex-basis:35%"><!-- wp:heading {"fontSize":"xxx-large"} -->
<h2 class="wp-block-heading has-xxx-large-font-size"><?php esc_html_e( 'Questions', 'anypress' ); ?></h2>
<!-- /wp:heading -->

<!-- wp:paragraph {"fontSize":"medium"} -->
<p class="has-medium-font-size"><a href="mailto:help@example.com"><?php esc_html_e( 'Ask us anything', 'anypress' ); ?></a></p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|small"}},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:details {"fontSize":"medium"} -->
<details class="wp-block-details has-medium-font-size"><summary><?php esc_html_e( 'Is my data safe?', 'anypress' ); ?></summary><!-- wp:paragraph -->
<p><?php esc_html_e( 'Your data is encrypted, backed up every day and never sold. You can export or delete it at any time.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></details>
<!-- /wp:details -->

<!-- wp:details {"fontSize":"medium"} -->
<details class="wp-block-details has-medium-font-size"><summary><?php esc_html_e( 'Can I import my old invoices?', 'anypress' ); ?></summary><!-- wp:paragraph -->
<p><?php esc_html_e( 'Yes. Upload a spreadsheet or connect your old tool and we bring everything across.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></details>
<!-- /wp:details -->

<!-- wp:details {"fontSize":"medium"} -->
<details class="wp-block-details has-medium-font-size"><summary><?php esc_html_e( 'What happens when the trial ends?', 'anypress' ); ?></summary><!-- wp:paragraph -->
<p><?php esc_html_e( 'You choose a plan or stay on Free. Nothing is deleted.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></details>
<!-- /wp:details -->

<!-- wp:details {"fontSize":"medium"} -->
<details class="wp-block-details has-medium-font-size"><summary><?php esc_html_e( 'Do you take a cut of payments?', 'anypress' ); ?></summary><!-- wp:paragraph -->
<p><?php esc_html_e( 'No. Card payments cost the processor\'s fee, and bank payments are free.', 'anypress' ); ?></p>
<!-- /wp:paragraph --></details>
<!-- /wp:details --></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns --></section>
<!-- /wp:group -->
