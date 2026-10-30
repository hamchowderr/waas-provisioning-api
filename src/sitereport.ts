/**
 * The "what's on this site" report shown after a site is moved in (docs/site-imports.md): which form, shop, CRM,
 * booking, support, affiliate and community plugins the moved site runs, how much data each holds, whether a Fluent
 * plugin can bring that data in (and whether it needs Pro), what a switch would lose, and what blocks one.
 *
 * The store agent counts (agent.php: site_inventory, run by check-site); the rules below turn the counts into plain
 * sentences. They follow the Fluent migration map (Fluent Forms 6.2, FluentCRM 3.3, FluentCart 2.2, FluentBooking 2.5,
 * Fluent Support 2.4, FluentAffiliate 1.7, FluentCommunity 2.12): change them when the Fluent plugins change.
 */

export const REPORT_AREAS = ['forms', 'shop', 'crm', 'booking', 'support', 'affiliates', 'community'] as const;
export type ReportArea = (typeof REPORT_AREAS)[number];

/** How a Fluent plugin can take over the data: its own importer, its importer with Pro, a separate add-on, or none yet. */
export type FluentRoute = 'native' | 'native-pro' | 'addon' | 'none';

/** What the store agent found (agent.php INVENTORY_PROBE). Only counts, yes/no and gateway ids: never a value. */
export interface SiteInventory {
  plugins?: InventoryPlugin[];
  /** Per plugin the report knows (the keys of RULES), its counts; null where its table isn't there. */
  found?: Record<string, Record<string, number | boolean | string[] | null>>;
  /** Per plugin, why it could not be counted. */
  errors?: Record<string, string>;
  /** Why nothing could be counted. */
  error?: string;
  seconds?: number;
}

export interface InventoryPlugin {
  slug: string;
  name: string;
  version: string;
}

export interface ReportCount {
  /** What is counted, e.g. "entries". */
  name: string;
  count: number;
  /** The count in words, e.g. "1,204 entries". */
  label: string;
}

export interface SiteReportItem {
  area: ReportArea;
  /** The plugin's name, e.g. "Contact Form 7". */
  plugin: string;
  slug: string;
  version?: string;
  counts: ReportCount[];
  fluentRoute: FluentRoute;
  /** The Fluent plugin that takes over (or would), e.g. "Fluent Forms". */
  fluentPlugin: string;
  /** The site already runs that Fluent plugin: nothing to switch. */
  onFluent: boolean;
  needsPro: boolean;
  /** The route in a few words, e.g. "Needs Fluent Forms Pro". */
  route: string;
  willLose: string[];
  blockers: string[];
}

export interface SiteReport {
  items: SiteReportItem[];
  /** Every plugin active on the moved site. */
  plugins: InventoryPlugin[];
  /** What could not be counted, in plain words. */
  notes: string[];
}

type Found = Record<string, number | boolean | string[] | null | undefined>;

interface Rule {
  area: ReportArea;
  plugin: string;
  fluentPlugin: string;
  onFluent?: boolean;
  /** [field, singular, plural]: the counts to show, in order; a missing or null field is left out. */
  counts: [string, string, string][];
  route: (f: Found, inv: Context) => FluentRoute;
  /** Needs Pro besides a native-pro route (Pro-only fields in use, for one). */
  needsPro?: (f: Found, inv: Context) => boolean;
  willLose: (f: Found, inv: Context) => (string | false | undefined)[];
  blockers?: (f: Found, inv: Context) => (string | false | undefined)[];
}

interface Context {
  /** Counts for another plugin on the same site. */
  other: (key: string) => Found | undefined;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const fmt = (v: number) => v.toLocaleString('en-US');
const plural = (count: number, one: string, many: string) => `${fmt(count)} ${count === 1 ? one : many}`;

/** Fluent Forms imports at most this many entries per form (BaseMigrator DEFAULT_ENTRY_MIGRATION_MAX_LIMIT). */
const ENTRY_CAP = 1000;

const FORM_PAGES = (f: Found) =>
  n(f.pages) > 0 &&
  `The form shortcodes and blocks on ${plural(n(f.pages), 'page', 'pages')} stay as they are: swap each one for the Fluent Forms form, or visitors see the old shortcode once the old plugin is off.`;
const ENTRY_LIMIT = (f: Found) =>
  n(f.largestForm ?? f.entries) > ENTRY_CAP && `Entries past the first ${fmt(ENTRY_CAP)} of each form: Fluent Forms brings in no more per form.`;
const PRO_FIELDS = (what: string) => (f: Found) =>
  n(f.proFieldForms) > 0 &&
  `${plural(n(f.proFieldForms), 'form uses', 'forms use')} ${what}, which only Fluent Forms Pro brings in. Without it those fields are dropped.`;
const NO_ROUTE_FORMS = (plugin: string) => (f: Found) => [
  `Fluent Forms can't bring in ${plugin} forms: rebuild them in Fluent Forms.`,
  n(f.entries) > 0 && `Past entries, unless you export them from ${plugin} as a CSV file first.`,
  FORM_PAGES(f),
];
const AFFILIATE_LOSS = (f: Found) => [
  'Settings: commission rates, cookie length and payout methods are set again in FluentAffiliate.',
  n(f.creatives) > 0 && `${plural(n(f.creatives), 'creative', 'creatives')}, unless FluentAffiliate Pro is installed.`,
];
const AFFILIATE_BLOCK = (f: Found, ctx: Context) =>
  n(ctx.other('fluent-affiliate')?.affiliates) > 0 &&
  'FluentAffiliate already holds affiliates on this site, and its importer only starts on an empty FluentAffiliate.';

const GATEWAYS: [RegExp, string][] = [
  [/^stripe/, 'Stripe'],
  [/^(ppcp|paypal|ppec)/, 'PayPal'],
  [/^square/, 'Square'],
  [/^authorize/, 'Authorize.Net'],
  [/^(woocommerce_payments|wcpay)/, 'WooPayments'],
  [/^braintree/, 'Braintree'],
  [/^mollie/, 'Mollie'],
];
const gatewayName = (id: string) => GATEWAYS.find(([pattern]) => pattern.test(id))?.[1] ?? id.replace(/[_-]+/g, ' ');

/** One rule per plugin the agent probes (its keys in INVENTORY_PROBE), in the order the report lists them. */
export const RULES: Record<string, Rule> = {
  'contact-form-7': {
    area: 'forms',
    plugin: 'Contact Form 7',
    fluentPlugin: 'Fluent Forms',
    counts: [['forms', 'form', 'forms'], ['entries', 'entry', 'entries'], ['pages', 'page with its forms', 'pages with its forms']],
    route: () => 'native',
    needsPro: (f) => n(f.proFieldForms) > 0,
    willLose: (f) => [
      'Email notifications and thank-you messages: set them up again in Fluent Forms.',
      'Hidden fields.',
      n(f.entries) > 0 && 'The original date of each entry: entries come in dated the day they are brought in.',
      f.flamingo !== true && n(f.entries) === 0 && 'Past messages: Contact Form 7 keeps none without Flamingo, so only the forms come across.',
      ENTRY_LIMIT(f),
      FORM_PAGES(f),
    ],
    blockers: (f) => [
      PRO_FIELDS('phone, file upload or range fields')(f),
      f.flamingo !== true && n(f.entries) > 0 && 'Flamingo is off: Fluent Forms reads Contact Form 7 entries through it, so switch Flamingo on before bringing them in.',
    ],
  },
  wpforms: {
    area: 'forms',
    plugin: 'WPForms',
    fluentPlugin: 'Fluent Forms',
    counts: [['forms', 'form', 'forms'], ['entries', 'entry', 'entries'], ['pages', 'page with its forms', 'pages with its forms']],
    route: () => 'native',
    needsPro: (f) => n(f.proFieldForms) > 0,
    willLose: (f) => [
      'Field conditions and the GDPR checkbox.',
      'Payment fields.',
      'Which thank-you message comes first: the conditional redirect becomes the default, so check it after the switch.',
      f.pro !== true && 'Entries: WPForms Lite keeps none on the site.',
      ENTRY_LIMIT(f),
      FORM_PAGES(f),
    ],
    blockers: (f) => [PRO_FIELDS('phone, file upload, page break, slider, repeater or rich text fields')(f)],
  },
  gravityforms: {
    area: 'forms',
    plugin: 'Gravity Forms',
    fluentPlugin: 'Fluent Forms',
    counts: [['forms', 'form', 'forms'], ['entries', 'entry', 'entries'], ['pages', 'page with its forms', 'pages with its forms']],
    route: () => 'native',
    needsPro: (f) => n(f.proFieldForms) > 0,
    willLose: (f) => [
      'Field conditions (conditions on emails and confirmations do come across).',
      'Payment, captcha, poll, quiz, survey and signature fields.',
      'Who sent each entry, with their IP address and browser.',
      ENTRY_LIMIT(f),
      FORM_PAGES(f),
    ],
    blockers: (f) => [PRO_FIELDS('phone, file upload, list or page fields')(f)],
  },
  'ninja-forms': {
    area: 'forms',
    plugin: 'Ninja Forms',
    fluentPlugin: 'Fluent Forms',
    counts: [['forms', 'form', 'forms'], ['entries', 'entry', 'entries'], ['pages', 'page with its forms', 'pages with its forms']],
    route: () => 'native',
    needsPro: (f) => n(f.proFieldForms) > 0,
    willLose: (f) => [
      'Field conditions and payment fields.',
      "Each email's Reply-To: it becomes the site's admin address.",
      'Date formats: check each date field after the switch.',
      ENTRY_LIMIT(f),
      FORM_PAGES(f),
    ],
    blockers: (f) => [PRO_FIELDS('phone, file upload, rating or repeater fields')(f)],
  },
  formidable: {
    area: 'forms',
    plugin: 'Formidable Forms',
    fluentPlugin: 'Fluent Forms',
    counts: [['forms', 'form', 'forms'], ['entries', 'entry', 'entries'], ['pages', 'page with its forms', 'pages with its forms']],
    route: () => 'none',
    willLose: NO_ROUTE_FORMS('Formidable'),
  },
  forminator: {
    area: 'forms',
    plugin: 'Forminator',
    fluentPlugin: 'Fluent Forms',
    counts: [['forms', 'form', 'forms'], ['entries', 'entry', 'entries'], ['pages', 'page with its forms', 'pages with its forms']],
    route: () => 'none',
    willLose: NO_ROUTE_FORMS('Forminator'),
  },
  'elementor-pro': {
    area: 'forms',
    plugin: 'Elementor Pro forms',
    fluentPlugin: 'Fluent Forms',
    counts: [['pages', 'page with a form', 'pages with a form'], ['entries', 'entry', 'entries']],
    route: () => 'none',
    willLose: (f) => [
      "Fluent Forms can't bring in Elementor forms: rebuild them in Fluent Forms and place them with its Elementor widget.",
      n(f.entries) > 0 && 'Past entries, unless you export them from Elementor → Submissions as a CSV file first.',
    ],
  },
  fluentform: {
    area: 'forms',
    plugin: 'Fluent Forms',
    fluentPlugin: 'Fluent Forms',
    onFluent: true,
    counts: [['forms', 'form', 'forms'], ['entries', 'entry', 'entries']],
    route: () => 'native',
    willLose: () => [],
  },
  woocommerce: {
    area: 'shop',
    plugin: 'WooCommerce',
    fluentPlugin: 'FluentCart',
    counts: [
      ['products', 'product', 'products'],
      ['orders', 'order', 'orders'],
      ['guestOrders', 'guest order', 'guest orders'],
      ['subscriptions', 'active subscription', 'active subscriptions'],
    ],
    route: () => 'addon',
    willLose: () => [
      'Shipping zones, product tags, gallery images and reviews.',
      'Payment gateway keys: connect each payment method again in FluentCart.',
      'Store emails and shortcodes on pages.',
    ],
    blockers: (f) => {
      const live = Array.isArray(f.liveGateways) ? f.liveGateways : [];
      return [
        f.hpos !== true &&
          n(f.orders) > 0 &&
          'WooCommerce keeps its orders the old way (HPOS is off). Turn on High-Performance Order Storage under WooCommerce → Settings → Advanced → Features and let it sync before moving orders.',
        n(f.subscriptions) > 0 &&
          `${plural(n(f.subscriptions), 'active subscription', 'active subscriptions')}: after a switch only those paid by card through Stripe keep renewing. Plan how the others renew before switching.`,
        live.length > 0 &&
          `Live payment keys came across for ${live.map(gatewayName).join(', ')}. Payments taken on this copy are real: put the gateways in test mode until it goes live.`,
      ];
    },
  },
  'easy-digital-downloads': {
    area: 'shop',
    plugin: 'Easy Digital Downloads',
    fluentPlugin: 'FluentCart',
    counts: [['products', 'product', 'products'], ['orders', 'order', 'orders'], ['subscriptions', 'active subscription', 'active subscriptions']],
    route: (f) => (f.edd3 === false ? 'none' : 'addon'),
    willLose: () => ['Payment gateway keys: connect each payment method again in FluentCart.', 'Store emails and shortcodes on pages.'],
    blockers: (f) => [
      f.edd3 === false && 'This is Easy Digital Downloads 2: update it to version 3 on the store first. FluentCart only brings in version 3.',
      n(f.subscriptions) > 0 &&
        `${plural(n(f.subscriptions), 'active subscription', 'active subscriptions')}: after a switch only those paid by card through Stripe keep renewing.`,
    ],
  },
  surecart: {
    area: 'shop',
    plugin: 'SureCart',
    fluentPlugin: 'FluentCart',
    counts: [['products', 'product', 'products']],
    route: () => 'none',
    willLose: () => ["FluentCart can't bring in SureCart yet: products, customers and orders stay in SureCart."],
  },
  'mailchimp-for-wp': {
    area: 'crm',
    plugin: 'Mailchimp for WordPress',
    fluentPlugin: 'FluentCRM',
    counts: [['forms', 'sign-up form', 'sign-up forms']],
    route: () => 'native',
    willLose: () => [
      'Campaigns, automations and their stats: FluentCRM brings in contacts, tags and lists from Mailchimp with an API key.',
      'The sign-up forms: rebuild them with Fluent Forms or FluentCRM.',
    ],
  },
  mailpoet: {
    area: 'crm',
    plugin: 'MailPoet',
    fluentPlugin: 'FluentCRM',
    counts: [['subscribers', 'subscriber', 'subscribers'], ['lists', 'list', 'lists'], ['emails', 'email', 'emails']],
    route: () => 'none',
    willLose: () => ['FluentCRM has no MailPoet importer: export the subscribers from MailPoet as a CSV file and import that.', 'Emails, automations and their stats.'],
  },
  newsletter: {
    area: 'crm',
    plugin: 'Newsletter',
    fluentPlugin: 'FluentCRM',
    counts: [['subscribers', 'confirmed subscriber', 'confirmed subscribers']],
    route: () => 'none',
    willLose: () => ['FluentCRM has no Newsletter importer: export the subscribers as a CSV file and import that.', 'Newsletters, automations and their stats.'],
  },
  'fluent-crm': {
    area: 'crm',
    plugin: 'FluentCRM',
    fluentPlugin: 'FluentCRM',
    onFluent: true,
    counts: [['contacts', 'contact', 'contacts']],
    route: () => 'native',
    willLose: () => [],
  },
  ameliabooking: {
    area: 'booking',
    plugin: 'Amelia',
    fluentPlugin: 'FluentBooking',
    counts: [['appointments', 'appointment', 'appointments'], ['customers', 'customer', 'customers']],
    route: () => 'none',
    willLose: () => ["FluentBooking can't bring in Amelia: set up the calendars again.", 'Past and upcoming appointments.'],
  },
  bookly: {
    area: 'booking',
    plugin: 'Bookly',
    fluentPlugin: 'FluentBooking',
    counts: [['appointments', 'appointment', 'appointments'], ['customers', 'customer', 'customers']],
    route: () => 'none',
    willLose: () => ["FluentBooking can't bring in Bookly: set up the calendars again.", 'Past and upcoming appointments.'],
  },
  'fluent-booking': {
    area: 'booking',
    plugin: 'FluentBooking',
    fluentPlugin: 'FluentBooking',
    onFluent: true,
    counts: [['calendars', 'calendar', 'calendars'], ['bookings', 'booking', 'bookings']],
    route: () => 'native',
    willLose: () => [],
  },
  'awesome-support': {
    area: 'support',
    plugin: 'Awesome Support',
    fluentPlugin: 'Fluent Support',
    counts: [['tickets', 'ticket', 'tickets'], ['replies', 'reply', 'replies']],
    route: () => 'native',
    willLose: () => ['Tags, products, custom fields and departments.'],
  },
  supportcandy: {
    area: 'support',
    plugin: 'SupportCandy',
    fluentPlugin: 'Fluent Support',
    counts: [['tickets', 'ticket', 'tickets']],
    route: (f) => (f.v3 === false ? 'none' : 'native'),
    willLose: (f) => [
      'Tags, products, custom fields and categories.',
      f.v3 !== false && "Everything in SupportCandy, if \"delete source\" is ticked when bringing tickets in: leave it off.",
    ],
    blockers: (f) => [f.v3 === false && 'This is SupportCandy 2: Fluent Support only brings in SupportCandy 3. Update SupportCandy on the store first.'],
  },
  'fluent-support': {
    area: 'support',
    plugin: 'Fluent Support',
    fluentPlugin: 'Fluent Support',
    onFluent: true,
    counts: [['tickets', 'ticket', 'tickets']],
    route: () => 'native',
    willLose: () => [],
  },
  'affiliate-wp': {
    area: 'affiliates',
    plugin: 'AffiliateWP',
    fluentPlugin: 'FluentAffiliate',
    counts: [['affiliates', 'affiliate', 'affiliates'], ['referrals', 'referral', 'referrals']],
    route: () => 'native',
    needsPro: (f) => n(f.creatives) > 0,
    willLose: AFFILIATE_LOSS,
    blockers: (f, ctx) => [AFFILIATE_BLOCK(f, ctx)],
  },
  slicewp: {
    area: 'affiliates',
    plugin: 'SliceWP',
    fluentPlugin: 'FluentAffiliate',
    counts: [['affiliates', 'affiliate', 'affiliates'], ['referrals', 'commission', 'commissions']],
    route: () => 'native',
    needsPro: (f) => n(f.creatives) > 0,
    willLose: AFFILIATE_LOSS,
    blockers: (f, ctx) => [AFFILIATE_BLOCK(f, ctx)],
  },
  'fluent-affiliate': {
    area: 'affiliates',
    plugin: 'FluentAffiliate',
    fluentPlugin: 'FluentAffiliate',
    onFluent: true,
    counts: [['affiliates', 'affiliate', 'affiliates'], ['referrals', 'referral', 'referrals']],
    route: () => 'native',
    willLose: () => [],
  },
  buddypress: {
    area: 'community',
    plugin: 'BuddyPress',
    fluentPlugin: 'FluentCommunity',
    counts: [['groups', 'group', 'groups'], ['posts', 'post', 'posts'], ['messages', 'private message', 'private messages']],
    route: () => 'native',
    willLose: (f) => [
      'Private messages, friendships, forums and profile fields.',
      'Post privacy: every post comes in public.',
      n(f.messages) > 0 && `${plural(n(f.messages), 'private message', 'private messages')} stay behind.`,
    ],
    blockers: (_f, ctx) => [
      n(ctx.other('fluent-community')?.posts) > 0 && 'FluentCommunity already has posts here, and bringing BuddyPress in can wipe them first. Back up before switching.',
    ],
  },
  'buddyboss-platform': {
    area: 'community',
    plugin: 'BuddyBoss',
    fluentPlugin: 'FluentCommunity',
    counts: [['groups', 'group', 'groups'], ['posts', 'post', 'posts'], ['messages', 'private message', 'private messages']],
    route: () => 'native',
    willLose: (f) => [
      'Private messages, friendships, forums and profile fields.',
      'Post privacy: every post comes in public.',
      n(f.messages) > 0 && `${plural(n(f.messages), 'private message', 'private messages')} stay behind.`,
    ],
    blockers: (_f, ctx) => [
      n(ctx.other('fluent-community')?.posts) > 0 && 'FluentCommunity already has posts here, and bringing BuddyBoss in can wipe them first. Back up before switching.',
    ],
  },
  bbpress: {
    area: 'community',
    plugin: 'bbPress',
    fluentPlugin: 'FluentCommunity',
    counts: [['forums', 'forum', 'forums'], ['topics', 'topic', 'topics'], ['replies', 'reply', 'replies']],
    route: () => 'none',
    willLose: () => ["FluentCommunity can't bring in bbPress forums: their topics and replies stay in bbPress."],
  },
  'fluent-community': {
    area: 'community',
    plugin: 'FluentCommunity',
    fluentPlugin: 'FluentCommunity',
    onFluent: true,
    counts: [['spaces', 'space', 'spaces'], ['posts', 'post', 'posts']],
    route: () => 'native',
    willLose: () => [],
  },
};

/** The plugin directories each rule covers, to name the plugin and its version from the active list. */
const SLUGS: Record<string, string[]> = {
  wpforms: ['wpforms', 'wpforms-lite'],
  formidable: ['formidable-pro', 'formidable'],
  'easy-digital-downloads': ['easy-digital-downloads-pro', 'easy-digital-downloads'],
  bookly: ['bookly-responsive-appointment-booking-tool'],
};

/** The route in a few words, for the dashboard and the connector. */
function routeText(route: FluentRoute, fluentPlugin: string, needsPro: boolean, onFluent: boolean): string {
  if (onFluent) return `Already on ${fluentPlugin}`;
  if (route === 'none') return 'No Fluent route yet';
  if (route === 'addon') return `Needs the ${fluentPlugin} Migrator add-on`;
  if (route === 'native-pro' || needsPro) return `Needs ${fluentPlugin} Pro`;
  return `${fluentPlugin} can bring this in`;
}

const sentences = (list: (string | false | undefined)[]) => list.filter((s): s is string => typeof s === 'string' && s.length > 0);

/** The report from what the store agent found; null when the agent found nothing at all (an older agent). */
export function siteReport(inventory: SiteInventory | undefined | null): SiteReport | null {
  if (!inventory || typeof inventory !== 'object') return null;
  const plugins = (Array.isArray(inventory.plugins) ? inventory.plugins : [])
    .filter((p) => p && typeof p.slug === 'string')
    .map((p) => ({ slug: String(p.slug).slice(0, 100), name: String(p.name ?? p.slug).slice(0, 100), version: String(p.version ?? '').slice(0, 30) }));
  if (inventory.error) {
    return { items: [], plugins, notes: ["The store couldn't count what this site holds. Open its admin to see which plugins it runs."] };
  }
  const found = inventory.found && typeof inventory.found === 'object' ? inventory.found : {};
  const errors = inventory.errors && typeof inventory.errors === 'object' ? inventory.errors : {};
  const ctx: Context = { other: (key) => found[key] as Found | undefined };
  const items: SiteReportItem[] = [];
  const notes: string[] = [];
  for (const [key, rule] of Object.entries(RULES)) {
    if (errors[key] !== undefined) notes.push(`The store couldn't count what ${rule.plugin} holds.`);
    const f = found[key] as Found | undefined;
    if (!f) continue;
    const slugs = SLUGS[key] ?? [key];
    const active = slugs.map((s) => plugins.find((p) => p.slug === s)).find(Boolean);
    const fluentRoute = rule.route(f, ctx);
    const onFluent = rule.onFluent === true;
    const needsPro = !onFluent && fluentRoute !== 'none' && (fluentRoute === 'native-pro' || (rule.needsPro?.(f, ctx) ?? false));
    const counts = rule.counts
      .filter(([field]) => typeof f[field] === 'number')
      .map(([field, one, many]) => ({ name: many, count: n(f[field]), label: plural(n(f[field]), one, many) }));
    items.push({
      area: rule.area,
      plugin: key === 'wpforms' ? (f.pro === true ? 'WPForms Pro' : 'WPForms Lite') : rule.plugin,
      slug: active?.slug ?? slugs[0]!,
      ...(active?.version && { version: active.version }),
      counts,
      fluentRoute,
      fluentPlugin: rule.fluentPlugin,
      onFluent,
      needsPro,
      route: routeText(fluentRoute, rule.fluentPlugin, needsPro, onFluent),
      willLose: onFluent ? [] : sentences(rule.willLose(f, ctx)),
      blockers: onFluent ? [] : sentences(rule.blockers?.(f, ctx) ?? []),
    });
  }
  items.sort((a, b) => REPORT_AREAS.indexOf(a.area) - REPORT_AREAS.indexOf(b.area));
  return { items, plugins, notes };
}
