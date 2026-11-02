# Block markup on this theme

Copy these shapes. Every value is a token; nothing is a fixed colour or pixel size.

## A section

```html
<!-- wp:group {"tagName":"section","metadata":{"name":"Services"},"align":"full","className":"is-style-section-tint","style":{"spacing":{"padding":{"top":"var:preset|spacing|xx-large","bottom":"var:preset|spacing|xx-large"},"margin":{"top":"0","bottom":"0"}}},"layout":{"type":"constrained","contentSize":"80rem"}} -->
<section class="wp-block-group alignfull is-style-section-tint" style="margin-top:0;margin-bottom:0;padding-top:var(--wp--preset--spacing--xx-large);padding-bottom:var(--wp--preset--spacing--xx-large)">
  <!-- wp:heading {"textAlign":"center","fontSize":"xx-large"} -->
  <h2 class="wp-block-heading has-text-align-center has-xx-large-font-size">What we do</h2>
  <!-- /wp:heading -->
</section>
<!-- /wp:group -->
```

`metadata.name` is the name the owner sees in the editor's List View: keep it short and plain.

## Text

```html
<!-- wp:paragraph {"textColor":"secondary","fontSize":"medium"} -->
<p class="has-secondary-color has-text-color has-medium-font-size">One clear sentence.</p>
<!-- /wp:paragraph -->
```

## Buttons

```html
<!-- wp:buttons {"layout":{"type":"flex"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/contact/">Book a visit</a></div>
<!-- /wp:button -->
<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="/services/">See services</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons -->
```

The main button takes the brand colour from the style; don't colour it by hand. A second one uses `is-style-outline`. Link to real pages (from `site_pages` list).

## Cards in columns

```html
<!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"left":"var:preset|spacing|medium","top":"var:preset|spacing|medium"}}}} -->
<div class="wp-block-columns alignwide"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:group {"className":"is-style-section-card","style":{"spacing":{"padding":{"top":"var:preset|spacing|medium","bottom":"var:preset|spacing|medium","left":"var:preset|spacing|medium","right":"var:preset|spacing|medium"}},"border":{"radius":"var:preset|border-radius|md"}},"layout":{"type":"default"}} -->
<div class="wp-block-group is-style-section-card" style="border-radius:var(--wp--preset--border-radius--md);padding-top:var(--wp--preset--spacing--medium);padding-right:var(--wp--preset--spacing--medium);padding-bottom:var(--wp--preset--spacing--medium);padding-left:var(--wp--preset--spacing--medium)">
<!-- wp:heading {"level":3,"fontSize":"large"} --><h3 class="wp-block-heading has-large-font-size">Boiler repair</h3><!-- /wp:heading -->
<!-- wp:paragraph --><p>Same-day callouts across the city.</p><!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->
```

## Image

```html
<!-- wp:image {"id":123,"sizeSlug":"large","linkDestination":"none","style":{"border":{"radius":"var:preset|border-radius|md"}}} -->
<figure class="wp-block-image size-large has-custom-border"><img src="https://example.com/wp-content/uploads/photo.jpg" alt="What the photo shows" class="wp-image-123" style="border-radius:var(--wp--preset--border-radius--md)"/></figure>
<!-- /wp:image -->
```

Use the id and address `add_image` returned.

## FAQ

WordPress's Accordion block, one item per question, styled `is-style-divided`:

```html
<!-- wp:accordion {"className":"is-style-divided"} -->
<div role="group" class="wp-block-accordion is-style-divided"><!-- wp:accordion-item -->
<div class="wp-block-accordion-item"><!-- wp:accordion-heading -->
<h3 class="wp-block-accordion-heading has-icon has-icon-right"><button type="button" class="wp-block-accordion-heading__toggle"><span class="wp-block-accordion-heading__toggle-title">Do you work weekends?</span><span class="wp-block-accordion-heading__toggle-icon" aria-hidden="true">+</span></button></h3>
<!-- /wp:accordion-heading -->
<!-- wp:accordion-panel -->
<div role="region" class="wp-block-accordion-panel"><!-- wp:paragraph -->
<p>Yes, Saturdays 8 to 2.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:accordion-panel --></div>
<!-- /wp:accordion-item --></div>
<!-- /wp:accordion -->
```

Simpler: start from a pattern with an FAQ (`site_patterns` find `faq`) and change its questions.

## Don't

- `"style":{"color":{"background":"#1a73e8"}}`, `font-size:18px`, `"fontFamily":"Arial"`: use slugs.
- Empty paragraphs or spacer blocks for space: use padding and block gap.
- Several h1s: one per page, in its first section.
