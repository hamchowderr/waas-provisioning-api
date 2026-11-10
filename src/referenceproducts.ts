// A reference's products into the store's shop (docs/references.md): the products read from a reference (Shopify,
// WooCommerce and the like) go to the store's AnyPress Client (/site/products, 2.19.0 or newer), which writes them
// with FluentCart's own importer, 20 at a time. They are drafts unless asked. A product added before (the same
// address) is left as it is, so running it again only adds what is missing. Descriptions and photos are carried over
// only from the owner's own shop (ownContent); from someone else's, a product keeps its name, prices, options and
// categories, and the owner writes the rest.
import type { ReferenceBundle, ReferenceProduct } from './referencesite.ts';
import type { SiteRequest, SiteResponse } from './sitekeys.ts';

type SiteCall = (request: SiteRequest) => Promise<SiteResponse>;

const BATCH = 20;

interface ProductResult {
  url: string | null;
  title: string;
  status: 'created' | 'exists' | 'failed';
  reason: string | null;
  id: number | null;
  storeStatus: string | null;
  link: string | null;
  images: number;
}

export interface ReferenceProductsAdded {
  summary: { products: number; created: number; exists: number; failed: number };
  results: ProductResult[];
  /** Products of the reference after this part: call again with offset + limit while it is above 0. */
  remaining: number;
  notes: string[];
}

interface StoreAnswer {
  url?: string | null;
  status?: string;
  reason?: string;
  id?: number | null;
  title?: string;
  images?: number;
  link?: string | null;
  productStatus?: string | null;
}

/** What the store's route takes for one product. */
function forStore(product: ReferenceProduct, ownContent: boolean, status: 'draft' | 'publish') {
  const categories = [product.type, ...product.tags].filter((name): name is string => !!name && name.trim() !== '').slice(0, 20);
  const variants = product.variants.length
    ? product.variants.map((v) => ({ title: v.title, sku: v.sku ?? undefined, price: v.price ?? '0', compareAtPrice: v.compareAtPrice ?? undefined, available: v.available }))
    : [{ price: product.price ?? '0', compareAtPrice: product.compareAtPrice ?? undefined }];
  return {
    title: product.title,
    url: product.url ?? undefined,
    status,
    categories,
    variants: variants.slice(0, 100),
    ...(ownContent ? { description: product.description, images: product.images.slice(0, 10) } : {}),
  };
}

function resultOf(product: ReferenceProduct, answer: StoreAnswer = {}): ProductResult {
  const { id = null, link = null, images = 0, productStatus = null } = answer;
  const base = { url: product.url, title: product.title, id, link, images, storeStatus: productStatus };
  if (answer.status === 'created' || answer.status === 'exists') return { ...base, status: answer.status, reason: null };
  return { ...base, status: 'failed', reason: answer.reason ?? 'The store gave no answer for this product' };
}

/** Sends one batch; a refused batch fails each of its products with the store's reason. */
async function addBatch(site: SiteCall, products: ReferenceProduct[], ownContent: boolean, status: 'draft' | 'publish'): Promise<ProductResult[]> {
  const answer = await site({ method: 'POST', path: '/products', body: { products: products.map((p) => forStore(p, ownContent, status)) } });
  const body = answer.body as { results?: StoreAnswer[]; message?: string } | null;
  if (answer.status !== 200 || !Array.isArray(body?.results)) {
    const reason = body?.message ?? `The store answered ${answer.status}`;
    return products.map((p) => ({ ...resultOf(p, undefined), reason }));
  }
  return products.map((p, i) => resultOf(p, body.results?.[i]));
}

export async function addReferenceProducts(
  bundle: ReferenceBundle,
  site: SiteCall,
  { ownContent, status, offset, limit }: { ownContent: boolean; status: 'draft' | 'publish'; offset: number; limit: number },
): Promise<ReferenceProductsAdded> {
  const part = bundle.products.slice(offset, offset + limit);
  const results: ProductResult[] = [];
  for (let i = 0; i < part.length; i += BATCH) {
    results.push(...(await addBatch(site, part.slice(i, i + BATCH), ownContent, status)));
  }
  const count = (s: ProductResult['status']) => results.filter((r) => r.status === s).length;
  const remaining = Math.max(0, bundle.products.length - offset - part.length);
  const notes: string[] = [];
  if (!bundle.products.length) notes.push('The reference has no products.');
  if (remaining) notes.push(`${remaining} more products: call again with offset ${offset + part.length}.`);
  if (!ownContent && part.length) notes.push('The reference is someone else’s shop, so only names, prices, options and categories were added: write each product’s own description and add its own photos.');
  if (count('created')) notes.push(status === 'draft' ? 'New products are drafts: the owner publishes them in FluentCart when they are ready.' : 'New products are published.');
  return { summary: { products: part.length, created: count('created'), exists: count('exists'), failed: count('failed') }, results, remaining, notes };
}
