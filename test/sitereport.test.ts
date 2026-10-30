import { describe, expect, it } from 'vitest';
import { RULES, siteReport, type SiteInventory } from '../src/sitereport.ts';

// The "what's on this site" report (src/sitereport.ts): the store agent's counts turned into routes, losses and blockers.

const plugins = (...slugs: string[]) => slugs.map((slug) => ({ slug, name: slug, version: '1.0' }));
const item = (inventory: SiteInventory, slug: string) => siteReport(inventory)!.items.find((i) => i.slug === slug)!;

describe('the site report', () => {
  it('maps Contact Form 7 with Flamingo, WooCommerce with HPOS off and MailPoet', () => {
    const report = siteReport({
      plugins: [
        { slug: 'contact-form-7', name: 'Contact Form 7', version: '6.1' },
        { slug: 'flamingo', name: 'Flamingo', version: '2.5' },
        { slug: 'woocommerce', name: 'WooCommerce', version: '10.2.1' },
        { slug: 'mailpoet', name: 'MailPoet', version: '5.3' },
        { slug: 'akismet', name: 'Akismet', version: '5.4' },
      ],
      found: {
        'contact-form-7': { forms: 3, proFieldForms: 1, entries: 1204, flamingo: true, pages: 4 },
        woocommerce: { products: 86, hpos: false, orders: 2310, guestOrders: 911, subscriptions: null, liveGateways: ['stripe', 'ppcp'] },
        mailpoet: { subscribers: 4120, lists: 3, emails: 57 },
      },
      errors: {},
    })!;
    expect(report.items.map((i) => [i.area, i.plugin])).toEqual([
      ['forms', 'Contact Form 7'],
      ['shop', 'WooCommerce'],
      ['crm', 'MailPoet'],
    ]);
    expect(report.plugins).toHaveLength(5);
    expect(report.notes).toEqual([]);

    const cf7 = report.items[0]!;
    expect(cf7).toMatchObject({ slug: 'contact-form-7', version: '6.1', fluentRoute: 'native', fluentPlugin: 'Fluent Forms', needsPro: true, onFluent: false, route: 'Needs Fluent Forms Pro' });
    expect(cf7.counts).toEqual([
      { name: 'forms', count: 3, label: '3 forms' },
      { name: 'entries', count: 1204, label: '1,204 entries' },
      { name: 'pages with its forms', count: 4, label: '4 pages with its forms' },
    ]);
    expect(cf7.willLose).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Email notifications and thank-you messages/), expect.stringMatching(/past the first 1,000/), expect.stringMatching(/4 pages stay/)]),
    );
    expect(cf7.blockers).toEqual(['1 form uses phone, file upload or range fields, which only Fluent Forms Pro brings in. Without it those fields are dropped.']);

    const woo = report.items[1]!;
    expect(woo).toMatchObject({ fluentRoute: 'addon', fluentPlugin: 'FluentCart', needsPro: false, route: 'Needs the FluentCart Migrator add-on' });
    expect(woo.counts.map((c) => c.label)).toEqual(['86 products', '2,310 orders', '911 guest orders']);
    expect(woo.blockers).toEqual([expect.stringMatching(/HPOS is off/), 'Live payment keys came across for Stripe, PayPal. Payments taken on this copy are real: put the gateways in test mode until it goes live.']);
    expect(JSON.stringify(woo)).not.toMatch(/sk_live|pk_live/);

    expect(report.items[2]).toMatchObject({ fluentRoute: 'none', route: 'No Fluent route yet', needsPro: false });
    expect(report.items[2]!.willLose[0]).toMatch(/CSV/);
  });

  it('names Flamingo as a blocker when Contact Form 7 has entries but Flamingo is off, and the loss when there are none', () => {
    const off = item({ plugins: plugins('contact-form-7'), found: { 'contact-form-7': { forms: 1, proFieldForms: 0, entries: 12, flamingo: false, pages: 1 } } }, 'contact-form-7');
    expect(off.blockers).toEqual([expect.stringMatching(/^Flamingo is off/)]);
    expect(off.needsPro).toBe(false);
    expect(off.route).toBe('Fluent Forms can bring this in');
    const none = item({ plugins: plugins('contact-form-7'), found: { 'contact-form-7': { forms: 1, proFieldForms: 0, entries: 0, flamingo: false, pages: 0 } } }, 'contact-form-7');
    expect(none.blockers).toEqual([]);
    expect(none.willLose).toContain('Past messages: Contact Form 7 keeps none without Flamingo, so only the forms come across.');
  });

  it('blocks on active subscriptions, and not on HPOS once it is on', () => {
    const woo = item({ plugins: plugins('woocommerce'), found: { woocommerce: { products: 2, hpos: true, orders: 40, guestOrders: 0, subscriptions: 12, liveGateways: [] } } }, 'woocommerce');
    expect(woo.blockers).toEqual([expect.stringMatching(/^12 active subscriptions: after a switch only those paid by card through Stripe/)]);
    expect(woo.counts.map((c) => c.label)).toContain('12 active subscriptions');
  });

  it('tells WPForms Lite from Pro, and Easy Digital Downloads 2 from 3', () => {
    const lite = item({ plugins: plugins('wpforms-lite'), found: { wpforms: { forms: 2, pro: false, entries: null, largestForm: null, proFieldForms: 0, pages: 2 } } }, 'wpforms-lite');
    expect(lite.plugin).toBe('WPForms Lite');
    expect(lite.counts.map((c) => c.name)).toEqual(['forms', 'pages with its forms']);
    expect(lite.willLose).toContain('Entries: WPForms Lite keeps none on the site.');
    const pro = item({ plugins: plugins('wpforms'), found: { wpforms: { forms: 2, pro: true, entries: 1500, largestForm: 900, proFieldForms: 0, pages: 0 } } }, 'wpforms');
    expect(pro.plugin).toBe('WPForms Pro');
    // No single form is past Fluent Forms' 1,000 entries.
    expect(pro.willLose.join(' ')).not.toMatch(/1,000/);

    const edd2 = item({ plugins: plugins('easy-digital-downloads'), found: { 'easy-digital-downloads': { products: 4, edd3: false, orders: 30, subscriptions: null } } }, 'easy-digital-downloads');
    expect(edd2).toMatchObject({ fluentRoute: 'none', route: 'No Fluent route yet' });
    expect(edd2.blockers[0]).toMatch(/Easy Digital Downloads 2/);
    expect(item({ plugins: plugins('easy-digital-downloads'), found: { 'easy-digital-downloads': { products: 4, edd3: true, orders: 30, subscriptions: null } } }, 'easy-digital-downloads').fluentRoute).toBe('addon');
  });

  it('marks a Fluent plugin already there, with nothing to lose', () => {
    const crm = item({ plugins: plugins('fluent-crm'), found: { 'fluent-crm': { contacts: 30 } } }, 'fluent-crm');
    expect(crm).toMatchObject({ onFluent: true, route: 'Already on FluentCRM', willLose: [], blockers: [], needsPro: false });
  });

  it('blocks an affiliate or community import onto a Fluent plugin that already has data', () => {
    const report = siteReport({
      plugins: plugins('affiliate-wp', 'fluent-affiliate', 'buddypress', 'fluent-community'),
      found: {
        'affiliate-wp': { affiliates: 10, referrals: 99, creatives: 3 },
        'fluent-affiliate': { affiliates: 1, referrals: 0 },
        buddypress: { groups: 2, members: 40, posts: 300, messages: 12, friendships: 5 },
        'fluent-community': { spaces: 1, posts: 4 },
      },
    })!;
    const awp = report.items.find((i) => i.slug === 'affiliate-wp')!;
    expect(awp).toMatchObject({ needsPro: true, route: 'Needs FluentAffiliate Pro' });
    expect(awp.blockers[0]).toMatch(/FluentAffiliate already holds affiliates/);
    expect(report.items.find((i) => i.slug === 'buddypress')!.blockers[0]).toMatch(/FluentCommunity already has posts/);
  });

  it('notes what could not be counted, and says so when nothing could', () => {
    const report = siteReport({ plugins: plugins('gravityforms', 'woocommerce'), found: { woocommerce: { products: 1, hpos: true, orders: 0, guestOrders: 0, subscriptions: null, liveGateways: [] } }, errors: { gravityforms: 'Table x is marked as crashed' } })!;
    expect(report.items.map((i) => i.slug)).toEqual(['woocommerce']);
    expect(report.notes).toEqual(["The store couldn't count what Gravity Forms holds."]);
    expect(JSON.stringify(report)).not.toContain('crashed');

    expect(siteReport({ error: 'wp exited 255: /var/www/html/wp-config.php' })).toEqual({
      items: [],
      plugins: [],
      notes: ["The store couldn't count what this site holds. Open its admin to see which plugins it runs."],
    });
    expect(siteReport(undefined)).toBeNull();
  });

  it('writes plain sentences: no internal names, ids or the old platform', () => {
    // Every rule, with every count set, so every sentence is produced at least once.
    const found = Object.fromEntries(
      Object.keys(RULES).map((key) => [
        key,
        { forms: 2, entries: 2000, pages: 3, proFieldForms: 1, flamingo: false, pro: false, products: 5, orders: 9, guestOrders: 2, subscriptions: 1, hpos: false, liveGateways: ['stripe'], edd3: false, v3: false,
          subscribers: 4, lists: 1, emails: 1, contacts: 1, appointments: 1, customers: 1, bookings: 1, calendars: 1, tickets: 1, replies: 1, affiliates: 1, referrals: 1, creatives: 1,
          groups: 1, members: 1, posts: 1, messages: 1, friendships: 1, forums: 1, topics: 1, spaces: 1 },
      ]),
    );
    const report = siteReport({ plugins: [], found })!;
    expect(report.items).toHaveLength(Object.keys(RULES).length);
    const text = report.items.flatMap((i) => [i.route, ...i.willLose, ...i.blockers, ...i.counts.map((c) => c.label)]).join('\n');
    expect(text).not.toMatch(/WPCS|undefined|null|NaN|\{|_/);
    for (const i of report.items) for (const s of [...i.willLose, ...i.blockers]) expect(s).toMatch(/^[A-Z0-9"].*[.]$/s);
  });
});
