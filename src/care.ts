/**
 * A store's care package (bought on the shop, src/pricing.ts `care`) and this month's care time, as the shop last
 * sent it (PUT /v1/tenants/care). The dashboard shows it on the store. Time used counts for the month it was sent in;
 * once that month is over and nothing new was sent, the month's time is shown as unused.
 */
export interface CareParams {
  /** The package's name, e.g. "Care Plus"; null when the store's care ends. */
  package: string | null;
  /** The package's minutes a month. */
  minutes?: number;
  /** Minutes used this month. */
  used?: number;
  /** Extra minutes bought, which never expire. */
  extra?: number;
  /** How soon requests are answered, e.g. "1 business day". */
  answer?: string;
  /** The month `used` counts for, "YYYY-MM" in the shop's time zone. */
  month?: string;
}

interface StoredCare {
  package: string;
  minutes: number;
  used: number;
  extra: number;
  answer: string;
  month: string;
}

export function storedCare(body: CareParams): StoredCare {
  return {
    package: body.package ?? '',
    minutes: body.minutes ?? 0,
    used: body.used ?? 0,
    extra: body.extra ?? 0,
    answer: body.answer ?? '',
    month: body.month ?? new Date().toISOString().slice(0, 7),
  };
}

/** The care shown on a tenant, or undefined without care. */
export function careOf(care: StoredCare | null | undefined, now = new Date()) {
  if (!care) return undefined;
  // A month the shop sent nothing for yet starts with all its time; a day's leeway covers the shop's time zone.
  const current = [now, new Date(now.getTime() - 24 * 3600 * 1000)].some((d) => d.toISOString().slice(0, 7) === care.month);
  const used = current ? care.used : 0;
  return {
    package: care.package,
    minutes: care.minutes,
    used,
    left: Math.max(0, care.minutes - used),
    extra: care.extra,
    answer: care.answer || undefined,
    month: current ? care.month : now.toISOString().slice(0, 7),
  };
}
