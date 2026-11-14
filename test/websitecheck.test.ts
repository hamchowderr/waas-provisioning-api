// The website check (src/websitecheck.ts): HTML in, a plain report for the business owner out.
import { describe, expect, it } from 'vitest';

import { analyze, type Fetched } from '../src/websitecheck.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const page = (html: string, over: Partial<Fetched> = {}): Fetched => ({
  requested: 'https://joes.example/',
  finalUrl: 'https://joes.example/',
  redirectsToHttps: true,
  status: 200,
  ms: 800,
  bytes: 200_000,
  html,
  ...over,
});
const status = (html: string, id: string, over?: Partial<Fetched>) => analyze(page(html, over), NOW).checks.find((c) => c.id === id)?.status;

const GOOD = `<!doctype html><html><head><title>Joe's Plumbing in Columbus, Ohio</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Emergency plumbing, drain cleaning and water heaters in Columbus. Same-day service, 7 days a week.">
<meta property="og:image" content="https://joes.example/og.jpg"><meta name="generator" content="WordPress 6.4"></head>
<body><h1>Plumbing done right</h1><a href="tel:+16145550100">Call</a><a href="/book">Book online</a>
<img src="a.jpg" alt="Van"><img src="b.jpg" alt="Team"><img src="c.jpg" alt="Sink"><footer>&copy; 2026 Joe's</footer></body></html>`;

describe('analyze', () => {
  it('passes a well-kept site', () => {
    const r = analyze(page(GOOD), NOW);
    expect(
      r.checks.every((c) => c.status === 'pass'),
      JSON.stringify(r.checks.filter((c) => c.status !== 'pass')),
    ).toBe(true);
    expect(r.score).toBe(100);
    expect(r.builder).toBe('WordPress');
    expect(r.host).toBe('joes.example');
  });

  it("fails an old, unsecured site that doesn't fit phones", () => {
    const html = `<html><head><title>Home</title></head><body><p>Welcome</p><p>Copyright 2016</p></body></html>`;
    const r = analyze(page(html, { finalUrl: 'http://joes.example/', redirectsToHttps: null, ms: 5200 }), NOW);
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(by).toMatchObject({ secure: 'fail', speed: 'fail', mobile: 'fail', fresh: 'fail', contact: 'fail', online: 'warn', heading: 'warn' });
    expect(r.checks.find((c) => c.id === 'fresh')!.detail).toContain('2016');
    expect(r.score).toBeLessThan(30);
  });

  it("warns when the plain address doesn't go to the secure one", () => {
    expect(status(GOOD, 'secure', { redirectsToHttps: false })).toBe('warn');
  });

  it('counts undescribed pictures only when there are a few', () => {
    expect(status(`<img src=a><img src=b><img src=c alt="x">`, 'images')).toBe('fail');
    expect(status(`<img src=a>`, 'images')).toBeUndefined();
  });
});

describe('what it finds', () => {
  it('names the builder and reads the newest copyright year', () => {
    expect(analyze(page(`<link href="https://static.wixstatic.com/x.css"><p>&copy; 2018-2021 Joe</p>`), NOW)).toMatchObject({ builder: 'Wix' });
    expect(analyze(page(`<p>hi</p>`), NOW).builder).toBeNull();
    expect(analyze(page(`<p>&copy; 2018-2026 Joe</p>`), NOW).checks.find((c) => c.id === 'fresh')!.status).toBe('pass');
  });

  it('leaves speed out when our own request for the page got no answer', () => {
    expect(analyze(page(GOOD, { ms: null }), NOW).checks.map((c) => c.id)).not.toContain('speed');
  });
});
