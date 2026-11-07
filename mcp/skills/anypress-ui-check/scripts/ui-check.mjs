#!/usr/bin/env node
// AnyPress UI check: opens a WordPress page in a real browser at desktop and phone width and checks
// what visitors touch: names and labels, focus, tap sizes, contrast, sideways scroll, images and
// the page's head.
//
//   node ui-check.mjs <url> [more urls ...] [--json]
//
// Needs Node 22+ and Playwright (`npm i playwright`, or a machine where require('playwright')
// already works). Run it against a WordPress Playground copy of the site, never a customer's live
// store. Exit code: 0 clean or WARN only, 2 when anything FAILs, 1 on a usage error.
//
// Made for AnyPress from Vercel's Web Interface Guidelines (MIT, Copyright (c) 2025 Vercel Labs),
// rewritten for WordPress block themes and Fluent Forms. Notices: ../NOTICE.md.
import { createRequire } from 'node:module';

// require() also finds a Playwright installed globally or in a parent folder.
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const json = args.includes('--json');
const urls = args.filter((a) => !a.startsWith('--'));
if (!urls.length) {
  console.error('Usage: ui-check.mjs <url> [...] [--json]');
  process.exit(1);
}

const SIZES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

// Everything here runs inside the page.
function inPage(viewName) {
  const out = [];
  const add = (level, id, message, examples = []) => out.push({ level, id, view: viewName, message, examples: [...new Set(examples)].slice(0, 5) });
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const describe = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 60);
  const nameOf = (el) => {
    if (el.getAttribute('aria-label')?.trim()) return el.getAttribute('aria-label').trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
    if (el.labels?.length) return [...el.labels].map((l) => l.textContent).join(' ').trim();
    if (el.title?.trim()) return el.title.trim();
    const img = el.querySelector?.('img[alt]');
    return (el.textContent || '').trim() || img?.alt?.trim() || '';
  };

  // Head: language, title, description, share tags, zoom.
  if (!document.documentElement.lang) add('FAIL', 'lang', 'The page has no language (html lang)');
  if (!document.title.trim()) add('FAIL', 'title', 'The page has no title');
  if (!document.querySelector('meta[name="description"][content]')) add('WARN', 'description', 'No meta description: search results and shares show a random line instead');
  if (!document.querySelector('meta[property="og:image"]')) add('WARN', 'share-image', 'No share image (og:image): links shared on social media show no picture');
  const vp = document.querySelector('meta[name="viewport"]')?.content || '';
  if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(vp)) add('FAIL', 'zoom-off', 'The page stops visitors zooming in');

  // Sideways scroll.
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  if (overflow > 1) {
    const wide = [...document.body.querySelectorAll('*')].filter((el) => visible(el) && el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}`);
    add('FAIL', 'sideways-scroll', `The page scrolls sideways by ${overflow}px`, wide);
  }

  // Controls need names; fields need labels you can see.
  const controls = [...document.querySelectorAll('a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, summary')].filter(visible);
  const unnamed = controls.filter((el) => !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !nameOf(el)).map((el) => el.outerHTML.slice(0, 80));
  if (unnamed.length) add('FAIL', 'no-name', 'Buttons or links with no name: icon-only ones need an aria-label', unnamed);
  const fields = controls.filter((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !['submit', 'button', 'reset', 'image'].includes(el.type));
  const unlabelled = fields.filter((el) => !el.labels?.length && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map((el) => el.name || el.id || el.placeholder || el.type);
  if (unlabelled.length) add('FAIL', 'field-label', 'Form fields without a label (a placeholder is not a label)', unlabelled);
  const noAuto = fields.filter((el) => /email|phone|tel|name/i.test(`${el.name} ${el.type} ${el.id}`) && !el.getAttribute('autocomplete')).map((el) => el.name || el.id);
  if (noAuto.length) add('WARN', 'autocomplete', 'Name, email and phone fields without autocomplete: phones can’t fill them in', noAuto);
  const wrongType = fields.filter((el) => el.tagName === 'INPUT' && el.type === 'text' && /(e-?mail|phone|tel)\b/i.test(`${el.name} ${el.id} ${el.labels?.[0]?.textContent || ''}`)).map((el) => el.name || el.id);
  if (wrongType.length) add('WARN', 'field-type', 'Email or phone fields typed as plain text: phones show the wrong keyboard', wrongType);

  // Tap sizes on a phone: links and buttons outside running text at least 44px.
  if (window.innerWidth < 600) {
    const small = controls.filter((el) => {
      if (el.closest('p, li p, td') && el.tagName === 'A' && !el.classList.contains('wp-block-button__link')) return false;
      const r = el.getBoundingClientRect();
      return (r.height < 44 && r.width < 44) || r.height < 24;
    }).map((el) => `${describe(el)} (${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)})`);
    if (small.length) add('WARN', 'tap-size', 'Small tap targets on a phone (under 44px)', small);
  }

  // Images.
  const imgs = [...document.images].filter(visible);
  const noAlt = imgs.filter((i) => !i.hasAttribute('alt')).map((i) => i.currentSrc || i.src);
  if (noAlt.length) add('FAIL', 'img-alt', 'Images without alt text', noAlt);
  const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src);
  if (broken.length) add('FAIL', 'img-broken', 'Images that didn’t load', broken);
  const noSize = imgs.filter((i) => !i.getAttribute('width') && !i.getAttribute('height') && !getComputedStyle(i).aspectRatio.includes('/')).map((i) => i.currentSrc || i.src);
  if (noSize.length) add('WARN', 'img-size', 'Images without a width and height or aspect ratio: the page jumps as they load', noSize);

  // Headings.
  const hs = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible);
  if (hs.filter((h) => h.tagName === 'H1').length !== 1) add('FAIL', 'h1', `The page needs exactly one main heading (h1); it has ${hs.filter((h) => h.tagName === 'H1').length}`);
  if (!document.querySelector('a[href^="#"].skip-link, a.skip-link, a[href="#wp--skip-link--target"]')) add('WARN', 'skip-link', 'No skip link: keyboard users have to tab through the whole menu');

  // Text contrast (WCAG AA): solid backgrounds only; text over photos is checked by eye.
  const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      // Text over a photo or video (a cover block, a hero image): checked by eye, not here.
      if (e.matches('.wp-block-cover, .wp-block-media-text__media') || [...e.children].some((c) => /^(IMG|VIDEO|PICTURE)$/.test(c.tagName) && getComputedStyle(c).position === 'absolute')) return null;
      const s = getComputedStyle(e);
      if (s.backgroundImage !== 'none' && !s.backgroundImage.startsWith('linear-gradient(rgba(0, 0, 0, 0)')) return null;
      const c = rgb(s.backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.9)) return c;
    }
    return [255, 255, 255];
  };
  const low = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const done = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || done.has(el) || !n.textContent.trim() || !visible(el)) continue;
    done.add(el);
    const s = getComputedStyle(el);
    const bg = bgOf(el);
    if (!bg) continue;
    const fg = rgb(s.color);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) low.push(`${ratio.toFixed(2)}:1 "${n.textContent.trim().slice(0, 40)}"`);
  }
  if (low.length) add('FAIL', 'contrast', 'Text below WCAG AA contrast', low);

  return out;
}

async function focusCheck(page, viewName) {
  // Tab through the first 20 stops. Each must look different focused than at rest (a ring, a
  // shadow, or a change of border, background or colour, after any transition settles), and not
  // sit under something such as a sticky header.
  const look = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const top = document.elementFromPoint(Math.min(rect.left + rect.width / 2, innerWidth - 1), Math.max(0, Math.min(rect.top + rect.height / 2, innerHeight - 1)));
    return {
      label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40),
      style: [s.outlineStyle !== 'none' ? `${s.outlineWidth} ${s.outlineColor}` : 'none', s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|'),
      covered: !!top && top !== el && !el.contains(top) && !top.contains(el),
    };
  });
  const missing = [];
  const hidden = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(350);
    const focused = await look();
    if (!focused) break;
    if (focused.covered) hidden.push(focused.label);
    await page.evaluate(() => { window.__uiCheckEl = document.activeElement; document.activeElement.blur(); });
    await page.waitForTimeout(350);
    const resting = await page.evaluate(() => {
      const s = getComputedStyle(window.__uiCheckEl);
      return [s.outlineStyle !== 'none' ? `${s.outlineWidth} ${s.outlineColor}` : 'none', s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine].join('|');
    });
    if (resting === focused.style) missing.push(focused.label);
    // Back to the same element, so the next Tab moves on from it.
    await page.evaluate(() => window.__uiCheckEl.focus());
  }
  const out = [];
  if (missing.length) out.push({ level: 'FAIL', id: 'focus-ring', view: viewName, message: 'Keyboard focus doesn\u2019t show on these', examples: [...new Set(missing)].slice(0, 5) });
  if (hidden.length) out.push({ level: 'WARN', id: 'focus-covered', view: viewName, message: 'Focused items hidden under something (often a sticky header)', examples: [...new Set(hidden)].slice(0, 5) });
  return out;
}

const browser = await chromium.launch();
const results = [];
try {
  for (const url of urls) {
    const findings = [];
    for (const size of SIZES) {
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      if (!res || res.status() >= 400) findings.push({ level: 'FAIL', id: 'http', view: size.name, message: `The page answered ${res ? res.status() : 'nothing'}`, examples: [] });
      // Scroll to the bottom so lazy images load, then back to the top.
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } scrollTo(0, 0); });
      await page.waitForTimeout(300);
      findings.push(...(await page.evaluate(inPage, size.name)));
      findings.push(...(await focusCheck(page, size.name)));
      await page.close();
    }
    results.push({ url, findings });
  }
} finally {
  await browser.close();
}

const all = results.flatMap((r) => r.findings);
const fails = all.filter((f) => f.level === 'FAIL').length;
const warns = all.filter((f) => f.level === 'WARN').length;
if (json) {
  console.log(JSON.stringify({ pass: fails === 0, fails, warns, results }, null, 2));
} else {
  for (const r of results) {
    console.log(r.url);
    for (const f of r.findings) {
      console.log(`  ${f.level} ${f.id} (${f.view}): ${f.message}`);
      for (const e of f.examples) console.log(`      ${e}`);
    }
    if (!r.findings.length) console.log('  clean');
  }
  console.log(fails ? `\n${fails} FAIL, ${warns} WARN: fix every FAIL before the site goes live.` : `\nPASS (${warns} WARN).`);
}
process.exit(fails ? 2 : 0);
