// Checks the AnyPress theme on WordPress Playground (WordPress and PHP inside Node, no Docker).
//
//   cd templates/playground && npm ci
//   npm run theme     # boot, run the checks, take screenshots, exit 1 on a failure
//   npm run serve     # same site, left running at http://127.0.0.1:9410 (admin / password)
//
// What it checks:
//   - the theme activates as a block theme and WordPress reads its presets and section styles
//   - every AnyPress pattern parses into valid blocks (the editor's own validation, run here with @wordpress/blocks)
//   - patterns use theme tokens only: no hex colours and no pixel sizes in block attributes
//   - every pattern has a description and keywords (the site tools search on them)
//   - every colour palette passes WCAG AA contrast (4.5:1) in every section style (contrast.mjs)
//   - WordPress lists the colour and typography style variations
//   - a page with every pattern renders without PHP errors; screenshots at phone and desktop width
//
// Environment: PLAYGROUND_WP, PLAYGROUND_PHP (default 7.1.3 and 8.3, what stores run), PLAYGROUND_PORT (9410),
// SHOTS (folder for screenshots, default ./shots). Screenshots need Playwright with Chromium.

import 'global-jsdom/register';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCLI } from '@wp-playground/cli';
import { checkContrast } from './contrast.mjs';

// Browser APIs the block library touches when it loads.
globalThis.matchMedia ??= () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);

const require = createRequire(import.meta.url);
const { parse, validateBlock, getBlockType } = require('@wordpress/blocks');
const { registerCoreBlocks } = require('@wordpress/block-library');

const HERE = dirname(fileURLToPath(import.meta.url));
const THEME = resolve(HERE, '../anypress-theme');
const WP = process.env.PLAYGROUND_WP || '7.1.3';
const PHP = process.env.PLAYGROUND_PHP || '8.3';
const PORT = Number(process.env.PLAYGROUND_PORT || 9410);
const SHOTS = resolve(process.env.SHOTS || resolve(HERE, 'shots'));
const SERVE = process.argv.includes('--serve');

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
const pass = (msg) => console.log(`  ok   ${msg}`);

const cli = await runCLI({
    command: 'server',
    wp: `https://wordpress.org/wordpress-${WP}.zip`,
    php: PHP,
    port: PORT,
    blueprint: {
        // Auto-login redirects cookie-less requests forever, so only when serving.
        login: SERVE,
        steps: [
            { step: 'defineWpConfigConsts', consts: { WP_DEBUG: true, WP_DEBUG_LOG: '/tmp/debug.log', WP_DEBUG_DISPLAY: false } },
            { step: 'activateTheme', themeFolderName: 'anypress' },
            { step: 'setSiteOptions', options: { blogname: 'Springfield Roofing', blogdescription: 'Family-run roofers since 2001' } },
        ],
    },
    mount: [{ hostPath: THEME, vfsPath: '/wordpress/wp-content/themes/anypress' }],
    verbosity: 'quiet',
});
const base = cli.serverUrl.replace(/\/$/, '');
console.log(`WordPress ${WP} on PHP ${PHP} at ${base}`);

async function php(code) {
    const res = await cli.playground.run({ code: `<?php require '/wordpress/wp-load.php'; ${code}` });
    if (res.errors) throw new Error(res.errors);
    return JSON.parse(res.text);
}

// 1. Theme and tokens as WordPress reads them.
console.log('Theme');
const info = await php(`
    $t = wp_get_theme();
    $s = wp_get_global_settings();
    $slugs = fn($a) => array_map(fn($x) => $x['slug'], $a['theme'] ?? []);
    $sections = array_filter(WP_Theme_JSON_Resolver::get_style_variations('block'), fn($v) => in_array('core/group', $v['blockTypes'] ?? [], true));
    $css = wp_get_global_stylesheet();
    echo json_encode([
        'name' => $t->get('Name'), 'block' => wp_is_block_theme(), 'active' => get_stylesheet(),
        'colors' => $slugs($s['color']['palette']), 'sizes' => $slugs($s['typography']['fontSizes']),
        'spacing' => $slugs($s['spacing']['spacingSizes']), 'radius' => $slugs($s['border']['radiusSizes'] ?? []),
        'fonts' => $slugs($s['typography']['fontFamilies']), 'custom' => $s['color']['custom'] ?? null,
        'viewport' => $s['viewport'] ?? null,
        'sections' => array_values(array_map(fn($v) => $v['slug'], $sections)),
        'radiusVar' => str_contains($css, '--wp--preset--border-radius--sm'),
        'variations' => array_map(fn($v) => $v['title'], WP_Theme_JSON_Resolver::get_style_variations()),
    ]);`);
info.active === 'anypress' && info.block ? pass(`${info.name} is the active block theme`) : fail(`theme not active: ${JSON.stringify(info)}`);
for (const slug of ['base', 'main', 'primary', 'secondary', 'tertiary', 'border-light']) {
    info.colors.includes(slug) ? null : fail(`colour slug ${slug} missing (stores' starter pages use it)`);
}
for (const slug of ['small', 'medium', 'large', 'xx-large']) {
    info.spacing.includes(slug) ? null : fail(`spacing slug ${slug} missing`);
}
pass(`${info.colors.length} colours, ${info.sizes.length} font sizes, ${info.spacing.length} spacing sizes, ${info.radius.length} radii, ${info.fonts.length} fonts`);
info.custom === false ? pass('custom colours off: blocks can only use the palette') : fail('custom colours are on');
info.viewport ? pass(`viewport breakpoints ${JSON.stringify(info.viewport)}`) : fail('settings.viewport not read');
info.sections.length >= 6 ? pass(`section styles: ${info.sections.join(', ')}`) : fail(`section styles: ${info.sections.join(', ')}`);
info.radiusVar ? pass('radius presets in the stylesheet') : fail('radius presets missing from the stylesheet');
info.variations.length >= 10 ? pass(`style variations: ${info.variations.join(', ')}`) : fail(`style variations: ${info.variations.join(', ')}`);

console.log('Contrast');
const contrast = checkContrast(pass);
contrast.forEach(fail);

// 2. Patterns: metadata, valid blocks, tokens only.
console.log('Patterns');
const patterns = await php(`
    $out = [];
    foreach (WP_Block_Patterns_Registry::get_instance()->get_all_registered() as $p) {
        if (str_starts_with($p['name'], 'anypress/')) $out[] = $p;
    }
    echo json_encode($out);`);
patterns.length ? pass(`${patterns.length} AnyPress patterns registered`) : fail('no AnyPress patterns registered');
const isStarter = (p) => p.categories?.includes('anypress/pages');
const starters = patterns.filter(isStarter);
starters.length ? pass(`${starters.length} starter pages: ${starters.map((p) => p.name).join(', ')}`) : fail('no starter pages');
for (const p of starters) {
    // WordPress swaps each core/pattern block for that pattern's blocks when it hands the pattern out.
    if (p.content.includes('<!-- wp:pattern ')) fail(`${p.name}: a section it uses is missing`);
    if (!p.blockTypes?.includes('core/post-content') || !p.postTypes?.includes('page')) fail(`${p.name}: not offered when a page is created`);
}
registerCoreBlocks();
const walk = (blocks, out = []) => { for (const b of blocks) { out.push(b); walk(b.innerBlocks, out); } return out; };
const silence = console.error, warn = console.warn, info2 = console.info;
for (const p of patterns) {
    const problems = [];
    if (!p.description?.trim()) problems.push('no description');
    if (!p.keywords?.length) problems.push('no keywords');
    console.error = console.warn = console.info = () => {};
    const blocks = walk(parse(p.content));
    const invalid = [];
    for (const b of blocks) {
        if (!b.name) continue;
        const type = getBlockType(b.name);
        if (!type) { invalid.push(`${b.name} (unknown block)`); continue; }
        const [ok, log] = validateBlock(b, type);
        if (!ok) invalid.push(`${b.name}: ${(log || []).map((l) => (l.args || []).slice(1).join(' ')).join('; ').slice(0, 240)}`);
    }
    console.error = silence; console.warn = warn; console.info = info2;
    if (invalid.length) problems.push(`invalid blocks: ${invalid.join(' | ')}`);
    const attrs = [...p.content.matchAll(/<!-- wp:\S+ (\{.*?\}) \/?-->/g)].map((m) => m[1]).join(' ');
    if (/#[0-9a-fA-F]{3,8}\b/.test(attrs)) problems.push('hex colour in block attributes');
    if (/"\d+(\.\d+)?px"/.test(attrs)) problems.push('pixel size in block attributes');
    // Post outlines are a post's own text, so they aren't wrapped in a named section.
    if (!p.categories?.includes('anypress/posts') && !blocks.some((b) => b.attributes?.metadata?.name)) problems.push('top-level block has no name');
    problems.length ? fail(`${p.name}: ${problems.join('; ')}`) : pass(`${p.name}: ${blocks.length} blocks, valid, tokens only`);
}

// 3. A page with every pattern, rendered.
console.log('Rendering');
const page = await php(`
    $content = '';
    foreach (WP_Block_Patterns_Registry::get_instance()->get_all_registered() as $p) {
        if (str_starts_with($p['name'], 'anypress/') && !in_array('anypress/pages', $p['categories'] ?? [], true)) $content .= $p['content'] . "\n\n";
    }
    $id = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'All sections', 'post_name' => 'all-sections', 'post_content' => $content]);
    update_post_meta($id, '_wp_page_template', 'page-no-title');
    echo json_encode(['id' => $id, 'url' => get_permalink($id)]);`);
const html = await (await fetch(`${base}/?page_id=${page.id}`)).text();
/Fatal error|Warning:|Notice:|Deprecated:/.test(html) ? fail('PHP error on the rendered page') : pass('page renders without PHP errors');
/is-style-section-[a-z-]+[^{]*\{[^}]*background-color/.test(html) ? pass('section style CSS generated for the sections used') : fail('section style CSS missing');
html.includes('fonts/figtree.woff2') ? pass('self-hosted fonts load') : fail('font files not referenced');
const starterPages = await php(`
    $out = [];
    foreach (WP_Block_Patterns_Registry::get_instance()->get_all_registered() as $p) {
        if (!in_array('anypress/pages', $p['categories'] ?? [], true)) continue;
        $out[$p['name']] = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => $p['title'], 'post_content' => $p['content']]);
    }
    echo json_encode($out);`);
for (const [name, id] of Object.entries(starterPages)) {
    const body = await (await fetch(`${base}/?page_id=${id}`)).text();
    /Fatal error|Warning:|Notice:|Deprecated:/.test(body) ? fail(`${name}: PHP error when rendered`) : pass(`${name}: renders as a page`);
}
const log = await php(`echo json_encode(file_exists('/tmp/debug.log') ? file_get_contents('/tmp/debug.log') : '');`);
log.trim() ? fail(`debug.log:\n${log.slice(0, 2000)}`) : pass('debug.log is empty');

// 4. Screenshots.
try {
    const { chromium } = require('playwright');
    mkdirSync(SHOTS, { recursive: true });
    const browser = await chromium.launch();
    for (const [name, width] of [['desktop', 1400], ['phone', 390]]) {
        const tab = await browser.newPage({ viewport: { width, height: 900 } });
        await tab.goto(`${base}/?page_id=${page.id}`, { waitUntil: 'networkidle' });
        // The innermost elements that stick out past the right edge, to say which section is too wide.
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 ? null : [...document.querySelectorAll('body *')]
            .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && ![...el.children].some((c) => c.getBoundingClientRect().right > window.innerWidth + 1))
            .slice(0, 5).map((el) => `${el.closest('[class*="wp-block-group"][class*="alignfull"]')?.className.match(/is-style-[\w-]+/)?.[0] ?? ''} <${el.tagName.toLowerCase()}> "${el.textContent.trim().slice(0, 40)}"`));
        overflow ? fail(`${name}: page scrolls sideways: ${overflow.join(' | ')}`) : pass(`${name}: no sideways scroll`);
        await tab.screenshot({ path: resolve(SHOTS, `all-sections-${name}.png`), fullPage: true });
        await tab.close();
    }
    await browser.close();
    pass(`screenshots in ${SHOTS}`);
} catch (e) {
    console.log(`  skip screenshots (${e.message.split('\n')[0]})`);
}

console.log(failures.length ? `\n${failures.length} problem(s)` : '\nAll checks passed');
if (SERVE) {
    console.log(`Serving at ${base} (Ctrl+C to stop)`);
} else {
    await cli[Symbol.asyncDispose]?.();
    process.exit(failures.length ? 1 : 0);
}
