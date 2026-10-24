/**
 * Tells the platform's CRM when an application to sell is approved, so the person is tagged there and
 * its welcome emails start (Beads waas-api-gtb.4). Set CRM_URL to the address that takes it and
 * CRM_SECRET to the secret it checks; both unset: off. AnyPress's own is the shop's
 * POST /wp-json/anypress/v1/offering (waas-plugins scripts/test-storefront/remote/anypress-crm.php),
 * which adds the "Seller: Active" or "Reseller: Active" tag.
 *
 * The request is POST CRM_URL with header X-CRM-Secret and the JSON body
 * {"email", "name", "business", "offering": "Seller" | "Reseller", "stage": "Active"}.
 */

export interface CrmConfig {
  url: string;
  secret: string;
}

export interface CrmContact {
  email: string;
  name: string;
  business: string;
}

export function loadCrmConfig(env: NodeJS.ProcessEnv): CrmConfig | undefined {
  const url = env.CRM_URL?.trim();
  const secret = env.CRM_SECRET?.trim();
  if (!url && !secret) return undefined;
  if (!url || !secret) throw new Error('CRM_URL and CRM_SECRET go together: set both, or neither');
  if (!/^https?:\/\//.test(url)) throw new Error('CRM_URL must be an http(s) address');
  return { url, secret };
}

/** Sends one lifecycle change. Never throws: the approval stands either way, and a failure is logged. */
export async function tellCrm(
  config: CrmConfig | undefined,
  offering: 'Seller' | 'Reseller',
  stage: 'Active',
  contact: CrmContact,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!config) return false;
  try {
    const res = await fetchFn(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CRM-Secret': config.secret },
      body: JSON.stringify({ ...contact, offering, stage }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return true;
  } catch (err) {
    console.error(`CRM ${offering}: ${stage} for ${contact.email}: ${(err as Error).message}`);
    return false;
  }
}
