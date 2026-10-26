// Colour contrast for the AnyPress theme: every palette (theme.json and styles/colors/*.json) against
// every section style, using the WCAG 2.2 formula. Text needs 4.5:1 (AA for normal-size text).
//
//   node contrast.mjs        # prints a table, exit 1 on a failure
//
// theme-check.mjs runs the same check.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const THEME = resolve(HERE, '../anypress-theme');
const MIN = 4.5;

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const dir = (path) => { try { return readdirSync(path).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } };

function luminance(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
};

// "var:preset|color|main" or "var(--wp--preset--color--main)" to its slug.
const slugOf = (value) => value?.match(/^var:preset\|color\|([a-z0-9-]+)$/)?.[1] ?? value?.match(/^var\(--wp--preset--color--([a-z0-9-]+)\)$/)?.[1];

// The colour pairs a page can show: [where, text, background]. "currentColor" means the context's text colour.
export function pairs() {
    const theme = json(resolve(THEME, 'theme.json'));
    const out = [];
    const add = (where, colors, button) => {
        const bg = slugOf(colors.background), text = slugOf(colors.text);
        out.push([`${where}: text`, text, bg]);
        if (button) {
            const bt = button.text === 'currentColor' ? text : slugOf(button.text);
            out.push([`${where}: button`, bt, slugOf(button.background)]);
        }
    };
    add('page', theme.styles.color, theme.styles.elements.button.color);
    // Muted and brand-coloured text that the patterns place on light backgrounds.
    for (const bg of ['base', 'tertiary', 'primary-accent']) {
        out.push([`${bg}: secondary text`, 'secondary', bg]);
        out.push([`${bg}: primary text`, 'primary', bg]);
    }
    for (const file of dir(resolve(THEME, 'styles/sections'))) {
        const s = json(resolve(THEME, 'styles/sections', file));
        add(s.slug, s.styles.color, s.styles.elements?.button?.color);
    }
    return out;
}

export function palettes() {
    const toMap = (list) => Object.fromEntries(list.map((c) => [c.slug, c.color]));
    const theme = json(resolve(THEME, 'theme.json'));
    const out = [['Default', toMap(theme.settings.color.palette)]];
    for (const file of dir(resolve(THEME, 'styles/colors'))) {
        const v = json(resolve(THEME, 'styles/colors', file));
        out.push([v.title, toMap(v.settings.color.palette)]);
    }
    return out;
}

// Returns a list of problems; empty when every pair passes.
export function checkContrast(log = () => {}) {
    const problems = [];
    const base = palettes()[0][1];
    for (const [name, palette] of palettes()) {
        const missing = Object.keys(base).filter((slug) => !palette[slug]);
        if (missing.length) problems.push(`${name}: missing ${missing.join(', ')}`);
        let worst = Infinity;
        for (const [where, text, bg] of pairs()) {
            if (!palette[text] || !palette[bg]) continue;
            const r = ratio(palette[text], palette[bg]);
            worst = Math.min(worst, r);
            if (r < MIN) problems.push(`${name}, ${where} (${text} on ${bg}): ${r.toFixed(2)}:1`);
        }
        log(`${name}: lowest ${worst.toFixed(2)}:1 across ${pairs().length} pairs`);
    }
    return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const problems = checkContrast(console.log);
    problems.forEach((p) => console.log(`  FAIL ${p}`));
    console.log(problems.length ? `\n${problems.length} pair(s) below ${MIN}:1` : `\nEvery pair is at least ${MIN}:1`);
    process.exit(problems.length ? 1 : 0);
}
