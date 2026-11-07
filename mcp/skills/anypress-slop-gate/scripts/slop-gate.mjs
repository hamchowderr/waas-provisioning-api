#!/usr/bin/env node
// AnyPress slop gate: checks a WordPress page's block markup for the signs of a page that was
// made in a hurry or by a machine, before anyone else sees it.
//
//   node slop-gate.mjs page.html [more.html ...] [--photos photos.txt] [--demo] [--json]
//   wp post get 42 --field=post_content | node slop-gate.mjs -
//
// Input is block markup as WordPress stores it (post_content, or what `site_pages` read returns).
// Each finding is FAIL (fix before anyone sees the page) or WARN (look, and fix unless there's a
// reason). --demo allows the made-up contact details a demo site uses (example.com addresses).
// Exit code: 0 clean or WARN only, 2 when anything FAILs, 1 on a usage error.
//
// Made for AnyPress from the mechanical gate in Higgsfield's website skill (MIT, Copyright (c)
// 2026 Higgsfield AI) and the copy lint in Taste Skill (MIT, Copyright (c) 2026 Leonxlnx),
// rewritten for block markup and the AnyPress theme. Notices: ../NOTICE.md.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const demo = args.includes('--demo');
const photosAt = args.indexOf('--photos');
const photosFile = photosAt >= 0 ? args[photosAt + 1] : undefined;
const inputs = args.filter((a, i) => !a.startsWith('--') && !(photosAt >= 0 && i === photosAt + 1));
if (!inputs.length) {
  console.error('Usage: slop-gate.mjs <page.html|-> [...] [--photos photos.txt] [--demo] [--json]');
  process.exit(1);
}

// ---------- word lists (from Taste Skill's copy lint, MIT) ----------
const SLOP = ['delve', 'delves', 'tapestry', 'testament to', 'realm', 'embark', 'beacon', 'multifaceted', 'paradigm', 'myriad', 'plethora', 'meticulous', 'meticulously', 'intricate', 'interplay', 'garner',
  'elevate', 'elevates', 'elevated', 'elevating', 'unlock', 'unlocks', 'unleash', 'unleashes', 'empower', 'empowers', 'empowering', 'harness', 'supercharge', 'supercharged', 'turbocharge', 'seamless', 'seamlessly', 'effortless', 'effortlessly',
  'cutting-edge', 'revolutionary', 'revolutionize', 'revolutionise', 'transformative', 'holistic', 'next-level', 'world-class', 'best-in-class', 'game-changer', 'game changer', 'game-changing', 'state-of-the-art', 'bespoke', 'synergy', 'leverage',
  'reimagine', 'reimagined', 'reimagining', 'next-generation', 'next-gen', 'robust', 'nestled', 'boasts', 'unparalleled', 'unrivaled', 'unrivalled'];
// The literal uses that are fine ("bespoke kitchens", "seamless gutters", "robust steel").
const LITERAL = {
  bespoke: /^\s+(tailoring|tailor|suits?|shirts?|shoes|joinery|kitchens?|furniture|cabinetry|wardrobes?)\b/i,
  seamless: /^\s+(gutters?|flooring|floors?|knit|steel|pipes?)\b/i,
  robust: /^\s+(steel|stainless|aluminium|aluminum|oak|timber|cast[- ]iron|frames?|hinges?|canvas|leather)\b/i,
  elevated: /^\s+(deck|terrace|walkway|platform|garden|beds?|view|views|site|plot)\b/i,
  unlock: /^s?\s+(the |your |a )?(door|doors|car|phone|locker|gate|box|room)\b/i,
  unlocks: /^\s+(the |your |a )?(door|doors|car|phone|locker|gate|box|room)\b/i,
  intricate: /^\s+(lace|beadwork|embroidery|carvings?|inlays?|plasterwork|ironwork|woodwork|joints?)\b/i,
};
const STOCK = [/in today'?s (fast-paced|digital|modern|ever-changing|busy)/i, /unlock the (power|potential)/i, /harness the power/i, /the future of [a-z]+ is (here|now)/i, /say goodbye to/i,
  /whether you'?re an? /i, /look no further/i, /join (thousands|millions|hundreds) of/i, /trusted by (teams|businesses|companies|brands|people) (worldwide|everywhere|around the world)/i, /imagine a world/i,
  /ready to (transform|take your|elevate|level up)/i, /ever-evolving/i, /one-stop shop/i, /take (it|your [a-z]+|things) to the next level/i,
  /\b(it'?s|this is|we'?re|we are) not just (a|an|another)\b/i, /\bnot only\b[^.!?]{1,60}\bbut also\b/i, /\bhere'?s the thing\b/i, /\blet'?s dive in\b/i,
  /\b(in|with) just a few clicks\b/i, /\bwe'?ve got you covered\b/i, /\bthe possibilities are endless\b/i, /\bat your fingertips\b/i, /\byour [a-z]+,? (simplified|elevated|reimagined)\b/i];
const RESIDUE = [/lorem ipsum/i, /\[(your |company |brand |business )?(company|brand|business|product|city|town|phone|email) ?(name)?\]/i, /\bcertainly!/i, /\bi hope this helps\b/i, /\bas an ai\b/i,
  /\[insert\b/i, /\bTODO\b/, /\bTBD\b/, /\{\{\s*[\w.]+\s*\}\}/, /\bgreat question!/i, /\bREMOVE_THIS\b/];
const SAMPLE_NAMES = /\b(Jane Doe|John Doe|John Smith|Acme|Lorem Corp|Your Company|Company Name)\b/i;
const SAMPLE_CONTACT = /[\w.+-]+@example\.(com|org|net)\b|\bexample\.(com|org|net)\b/gi;
const VAGUE_CTA = /^(click here|learn more|read more|submit|go|more|here|continue)$/i;

// ---------- block markup parsing ----------
const BLOCK = /<!--\s+(\/)?wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(\s+(\{[\s\S]*?\}))?\s+(\/)?-->/g;
function parseBlocks(markup) {
  const root = { name: 'root', attrs: {}, children: [], html: '' };
  const stack = [root];
  let last = 0;
  for (const m of markup.matchAll(BLOCK)) {
    const top = stack[stack.length - 1];
    top.html += markup.slice(last, m.index);
    last = m.index + m[0].length;
    const [, closing, rawName, , rawAttrs, selfClosing] = m;
    const name = rawName.includes('/') ? rawName : `core/${rawName}`;
    if (closing) {
      // Close up to the matching opener (tolerates a missing closer inside).
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { stack.length = i; break; }
      continue;
    }
    let attrs = {};
    if (rawAttrs) try { attrs = JSON.parse(rawAttrs); } catch { attrs = { __bad: rawAttrs }; }
    const block = { name, attrs, rawAttrs: rawAttrs || '', children: [], html: '' };
    top.children.push(block);
    if (!selfClosing) stack.push(block);
  }
  stack[stack.length - 1].html += markup.slice(last);
  return root.children.filter((b) => b.name !== 'core/freeform' || b.html.trim());
}
const walk = (blocks, fn, depth = 0, parent = null) => blocks.forEach((b, i) => { fn(b, depth, parent, i); walk(b.children, fn, depth + 1, b); });
const allHtml = (b) => b.html + b.children.map(allHtml).join('');
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
const textOf = (html) => decode(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// A section's shape: its block, its layout and its children's blocks, three levels down. Two sections in a row
// with the same shape are the same layout twice.
const shapeOf = (b, depth = 0) => {
  const cols = b.name === 'core/columns' ? `(${b.children.length})` : b.attrs.layout?.type ? `(${b.attrs.layout.type}${b.attrs.layout.columnCount || ''})` : '';
  const kids = depth < 3 ? b.children.filter((c) => !/core\/(paragraph|heading|spacer|separator)$/.test(c.name)).map((c) => shapeOf(c, depth + 1)) : [];
  return `${b.name}${cols}${kids.length ? `[${kids.join(',')}]` : ''}`;
};

// ---------- the checks ----------
function check(markup, file, photoList) {
  const findings = [];
  const add = (level, id, message, examples = []) => findings.push({ level, id, file, message, examples: [...new Set(examples)].slice(0, 5) });
  const blocks = parseBlocks(markup);
  const sections = blocks.filter((b) => !/^core\/(spacer|separator)$/.test(b.name));
  const html = blocks.map(allHtml).join('');
  // Curly apostrophes as straight ones, so “we’ve” matches the same lists as "we've".
  const text = textOf(html).replace(/[\u2018\u2019]/g, "'");

  // 1. Placeholders and leftovers.
  const residue = RESIDUE.flatMap((re) => text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) || []);
  if (residue.length) add('FAIL', 'placeholder', 'Placeholder or leftover text is still on the page', residue);
  const samples = text.match(new RegExp(SAMPLE_NAMES.source, 'gi')) || [];
  if (samples.length) add('FAIL', 'sample-name', 'A sample name is still on the page: use the business’s own', samples);
  const contacts = demo ? [] : text.match(SAMPLE_CONTACT) || [];
  if (contacts.length) add('FAIL', 'sample-contact', 'A sample email or web address is still on the page: use the business’s own (on a demo, run with --demo)', contacts);
  const placeholderImgs = [...html.matchAll(/<img[^>]+src="([^"]*placeholder[^"]*)"/gi)].map((m) => m[1]);
  if (placeholderImgs.length) add('FAIL', 'placeholder-image', 'A placeholder image is still on the page: swap in a real photo with add_image', placeholderImgs);
  const emptySrc = [...html.matchAll(/<img[^>]+src=""/gi)].length;
  if (emptySrc) add('FAIL', 'empty-image', `${emptySrc} image(s) have no picture`);

  // 2. Long dashes in what visitors read.
  const dashes = [...text.matchAll(/[^.!?]{0,40}[—–][^.!?]{0,40}/g)].map((m) => m[0].trim());
  if (dashes.length) add('FAIL', 'long-dash', 'Long dashes (— or –) in the copy: use a full stop, comma, colon or brackets', dashes);

  // 3. Fixed colours and sizes instead of the theme's slugs.
  const fixedColour = [];
  const fixedSize = [];
  walk(blocks, (b) => {
    if (b.attrs.__bad) add('FAIL', 'bad-block', `${b.name} has attributes WordPress can't read`, [b.attrs.__bad.slice(0, 80)]);
    const raw = b.rawAttrs;
    for (const m of raw.matchAll(/"(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))"/g)) fixedColour.push(`${b.name}: ${m[1]}`);
    for (const k of ['customTextColor', 'customBackgroundColor', 'customGradient', 'customOverlayColor']) if (b.attrs[k]) fixedColour.push(`${b.name}: ${k} ${b.attrs[k]}`);
    const style = b.attrs.style || {};
    const sizes = [style.typography?.fontSize, style.typography?.lineHeight && /px/.test(style.typography.lineHeight) ? style.typography.lineHeight : undefined,
      ...Object.values(style.spacing?.padding || {}), ...Object.values(style.spacing?.margin || {}), typeof style.spacing?.blockGap === 'string' ? style.spacing.blockGap : undefined,
      ...Object.values(style.spacing?.blockGap && typeof style.spacing.blockGap === 'object' ? style.spacing.blockGap : {})];
    for (const v of sizes) if (typeof v === 'string' && /\d(px|rem|em|vw|vh)\b/.test(v) && !v.startsWith('var:')) fixedSize.push(`${b.name}: ${v}`);
  });
  if (fixedColour.length) add('FAIL', 'fixed-colour', 'Fixed colours in blocks: use the theme’s colour slugs (primary, base, main...) so the Site Editor can restyle the page', fixedColour);
  if (fixedSize.length) add('FAIL', 'fixed-size', 'Fixed sizes in blocks: use the theme’s font-size and spacing slugs (var:preset|spacing|large, fontSize "large")', fixedSize);

  // 4. The same layout twice in a row, and too few layouts on a long page.
  const shapes = sections.map((b) => ({ shape: shapeOf(b), name: b.attrs.metadata?.name || b.name }));
  const repeats = [];
  for (let i = 1; i < shapes.length; i++) if (shapes[i].shape === shapes[i - 1].shape && shapes[i].shape.includes('[')) repeats.push(`${shapes[i - 1].name} then ${shapes[i].name}`);
  if (repeats.length) add('FAIL', 'repeated-layout', 'The same layout twice in a row: pick a different pattern for one of them', repeats);
  const distinct = new Set(shapes.map((s) => s.shape)).size;
  if (sections.length >= 6 && distinct < 4) add('WARN', 'few-layouts', `${sections.length} sections but only ${distinct} different layouts: a page this long needs at least 4`);

  // 5. Small labels above headings ("eyebrows"): at most one for every three sections.
  let eyebrows = 0;
  const eyebrowText = [];
  walk(blocks, (b, _d, parent) => {
    if (b.name !== 'core/paragraph' || !parent) return;
    const sib = parent.children[parent.children.indexOf(b) + 1];
    const small = ['x-small', 'small'].includes(b.attrs.fontSize) || b.attrs.style?.typography?.textTransform === 'uppercase' || /eyebrow|kicker/.test(b.attrs.className || '');
    if (small && sib?.name === 'core/heading') { eyebrows++; eyebrowText.push(textOf(b.html)); }
  });
  const budget = Math.max(1, Math.ceil(sections.length / 3));
  if (eyebrows > budget) add('FAIL', 'too-many-labels', `${eyebrows} small labels above headings; this page allows ${budget} (one for every three sections). Drop the rest: the heading is enough`, eyebrowText);

  // 6. Photos: alt text, repeats, the planned photo list.
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => !/\balt="[^"]+"/.test(t) && !/aria-hidden="true"|role="presentation"/.test(t)).map((t) => (t.match(/src="([^"]*)"/) || [])[1] || t.slice(0, 60));
  if (noAlt.length) add('FAIL', 'img-alt', 'Images without alt text: say what the photo shows', noAlt);
  const srcs = [...imgs.map((t) => (t.match(/src="([^"]+)"/) || [])[1]), ...[...html.matchAll(/background-image:\s*url\(([^)]+)\)/g)].map((m) => m[1])].filter(Boolean).map((s) => s.replace(/["']/g, '').replace(/-\d+x\d+(\.\w+)$/, '$1'));
  const seen = new Map();
  for (const s of srcs) seen.set(s, (seen.get(s) || 0) + 1);
  const twice = [...seen].filter(([, n]) => n > 1).map(([s]) => s);
  if (twice.length) add('WARN', 'photo-repeat', 'The same photo appears more than once on this page', twice);
  if (photoList) {
    const unused = photoList.filter((p) => !srcs.some((s) => s.includes(p) || p.includes(s)));
    if (unused.length) add('WARN', 'photo-unused', 'Photos from the plan that this page doesn’t use (fine if another page does)', unused);
  }

  // 7. Links and buttons.
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: (m[1].match(/href="([^"]*)"/) || [])[1], label: textOf(m[2]), cls: (m[1].match(/class="([^"]*)"/) || [])[1] || '' }));
  const dead = anchors.filter((a) => a.href === undefined || a.href === '' || a.href === '#').map((a) => a.label || '(no label)');
  if (dead.length) add('FAIL', 'dead-link', 'Links that go nowhere (href="#" or empty)', dead);
  const buttons = anchors.filter((a) => /wp-block-button__link|wp-element-button/.test(a.cls));
  const byHref = new Map();
  for (const b of buttons) if (b.href && b.href !== '#') byHref.set(b.href, new Set([...(byHref.get(b.href) || []), b.label.toLowerCase()]));
  const mixed = [...byHref].filter(([href, labels]) => labels.size > 1 && !href.startsWith('tel:')).map(([href, l]) => `${href}: ${[...l].join(' / ')}`);
  if (mixed.length) add('WARN', 'cta-labels', 'One action, several labels: pick one wording for each action and use it everywhere', mixed);
  const vague = buttons.filter((b) => VAGUE_CTA.test(b.label)).map((b) => b.label);
  if (vague.length) add('WARN', 'vague-button', 'Buttons that don’t say what happens: name the action ("Book a visit", "Get a quote")', vague);
  const long = buttons.filter((b) => b.label.split(/\s+/).length > 4).map((b) => b.label);
  if (long.length) add('WARN', 'long-button', 'Button labels over four words', long);
  const empty = anchors.filter((a) => !a.label && !/aria-label=/.test(a.cls)).length;
  if (empty) add('WARN', 'link-no-text', `${empty} link(s) with no visible text: give them words or an aria-label`);

  // 8. Headings.
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  if (levels.filter((l) => l === 1).length > 1) add('FAIL', 'two-h1', 'More than one main heading (h1) on the page');
  const jumps = [];
  for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) jumps.push(`h${levels[i - 1]} to h${levels[i]}`);
  if (jumps.length) add('WARN', 'heading-order', 'Headings skip a level', jumps);

  // 9. Stock copy.
  const slop = [];
  for (const w of SLOP) {
    const re = new RegExp(`(?<![\\w-])${w.replace(/[-]/g, '\\-')}(?![\\w-])`, 'gi');
    for (const m of text.matchAll(re)) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
      if (LITERAL[w.toLowerCase()]?.test(after)) continue;
      slop.push(text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25).trim());
    }
  }
  if (slop.length) add('FAIL', 'stock-word', 'Stock marketing words: replace each with the fact it stands for (the price, the time, the place, the material)', slop);
  const stock = STOCK.flatMap((re) => (text.match(new RegExp(re.source, 'gi')) || []));
  if (stock.length) add('FAIL', 'stock-phrase', 'Stock phrases: say the plain thing instead', stock);
  const figures = [...text.matchAll(/[^.!?]{0,30}\b\d{1,3}(\.\d)?\s?(%|x\b|×)[^.!?]{0,30}/g)].map((m) => m[0].trim()).filter((s) => /faster|more|better|increase|boost|growth|roi|satisf|happier|save/i.test(s));
  if (figures.length) add('WARN', 'invented-figure', 'Performance figures: keep them only if the business can back them up', figures);

  return { file, sections: sections.length, layouts: distinct, findings };
}

const photoList = photosFile ? readFileSync(photosFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : undefined;
const results = inputs.map((f) => check(readFileSync(f === '-' ? 0 : f, 'utf8'), f === '-' ? 'stdin' : f, photoList));
const fails = results.flatMap((r) => r.findings).filter((f) => f.level === 'FAIL').length;
const warns = results.flatMap((r) => r.findings).filter((f) => f.level === 'WARN').length;

if (json) {
  console.log(JSON.stringify({ pass: fails === 0, fails, warns, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.file}: ${r.sections} sections, ${r.layouts} layouts`);
    for (const f of r.findings) {
      console.log(`  ${f.level} ${f.id}: ${f.message}`);
      for (const e of f.examples) console.log(`      ${e}`);
    }
    if (!r.findings.length) console.log('  clean');
  }
  console.log(fails ? `\n${fails} FAIL, ${warns} WARN: fix every FAIL before anyone sees the page.` : `\nPASS (${warns} WARN).`);
}
process.exit(fails ? 2 : 0);
