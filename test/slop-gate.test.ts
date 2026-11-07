import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The anypress-slop-gate skill's script, run the way an agent runs it.
const SCRIPT = fileURLToPath(new URL('../mcp/skills/anypress-slop-gate/scripts/slop-gate.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'slop-gate-'));

function gate(markup: string, ...flags: string[]) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, markup);
  const run = spawnSync(process.execPath, [SCRIPT, file, '--json', ...flags], { encoding: 'utf8' });
  const report = JSON.parse(run.stdout) as { pass: boolean; results: { findings: { level: string; id: string }[] }[] };
  return { status: run.status, ids: report.results[0]!.findings.map((f) => `${f.level} ${f.id}`) };
}

const section = (name: string, inner: string, style = 'is-style-section-tint') =>
  `<!-- wp:group {"tagName":"section","metadata":{"name":"${name}"},"align":"full","className":"${style}","layout":{"type":"constrained"}} -->\n<section class="wp-block-group alignfull ${style}">${inner}</section>\n<!-- /wp:group -->\n`;
const heading = (text: string, level = 2) => `<!-- wp:heading {"level":${level}} -->\n<h${level} class="wp-block-heading">${text}</h${level}>\n<!-- /wp:heading -->`;
const para = (text: string, attrs = '') => `<!-- wp:paragraph ${attrs}-->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
const image = (src: string, alt: string) => `<!-- wp:image {"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${src}" alt="${alt}"/></figure>\n<!-- /wp:image -->`;
const button = (href: string, label: string) =>
  `<!-- wp:buttons -->\n<div class="wp-block-buttons"><!-- wp:button -->\n<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="${href}">${label}</a></div>\n<!-- /wp:button --></div>\n<!-- /wp:buttons -->`;
const split = (left: string, right: string) =>
  `<!-- wp:columns -->\n<div class="wp-block-columns"><!-- wp:column -->\n<div class="wp-block-column">${left}</div>\n<!-- /wp:column --><!-- wp:column -->\n<div class="wp-block-column">${right}</div>\n<!-- /wp:column --></div>\n<!-- /wp:columns -->`;

describe('the slop gate', () => {
  it('passes a finished page', () => {
    const page =
      section('Hero', split(heading('Emergency plumbers in Springfield, there within the hour', 1) + para('Family firm since 2001. Fixed price before we start.') + button('tel:5550142', 'Call 555 0142'), image('https://cdn.test/van.jpg', 'Our van outside a house'))) +
      section('Services', heading('What we fix') + para('Leaks from $150, drains from $120, water heaters from $950.'), 'is-style-section-card') +
      section('Book', split(image('https://cdn.test/sink.jpg', 'A plumber fixing a kitchen sink'), heading('Book a visit') + button('/book/', 'Book a visit')));
    expect(gate(page)).toEqual({ status: 0, ids: [] });
  });

  it('fails what a rushed or machine-made page leaves behind', () => {
    const page =
      section('Hero', split(para('Plumbing', '{"fontSize":"x-small"} ') + heading('Elevate your plumbing', 1) + para('Lorem ipsum — we’ve got you covered.') + button('#', 'Learn more'), image('https://x.test/assets/images/placeholder-wide.svg', ''))) +
      section('One', split(para('Why us', '{"fontSize":"small"} ') + heading('Why us') + image('https://cdn.test/a.jpg', 'A'), para('x'))) +
      section('Two', split(para('Reviews', '{"fontSize":"small"} ') + heading('Reviews') + image('https://cdn.test/a.jpg', 'A'), para('y'))) +
      `<!-- wp:paragraph {"style":{"color":{"text":"#ff5c1a"},"typography":{"fontSize":"17px"}}} -->\n<p>Call hello@example.com</p>\n<!-- /wp:paragraph -->\n` +
      `<!-- wp:heading {"level":1} -->\n<h1 class="wp-block-heading">Again</h1>\n<!-- /wp:heading -->`;
    const { status, ids } = gate(page);
    expect(status).toBe(2);
    expect(ids).toEqual(
      expect.arrayContaining([
        'FAIL placeholder', 'FAIL sample-contact', 'FAIL placeholder-image', 'FAIL long-dash', 'FAIL fixed-colour', 'FAIL fixed-size', 'FAIL repeated-layout',
        'FAIL too-many-labels', 'FAIL img-alt', 'WARN photo-repeat', 'FAIL dead-link', 'WARN vague-button', 'FAIL two-h1', 'FAIL stock-word', 'FAIL stock-phrase',
      ]),
    );
  });

  it('allows made-up contacts on a demo and literal uses of marketing words', () => {
    const page = section('Contact', heading('Bespoke kitchens and seamless gutters') + para('Write to hello@example.com.') + button('/contact/', 'Get a quote'));
    expect(gate(page, '--demo')).toEqual({ status: 0, ids: [] });
    expect(gate(page).ids).toEqual(['FAIL sample-contact']);
  });
});
