// Creates an API key and prints the key and secret once. Only the secret's hash is stored.
//   npm run create-key -- --product-name "My storefront"   (new product)
//   npm run create-key -- --product <uuid>                 (another key for an existing product)
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { createPool, migrate } from '../db.ts';
import { createApiKey } from '../keys.ts';

const { values } = parseArgs({ options: { product: { type: 'string' }, 'product-name': { type: 'string' }, label: { type: 'string' } } });
if (!values.product === !values['product-name']) {
  console.error('Pass either --product <uuid> or --product-name <name>');
  process.exit(1);
}

const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl);
try {
  const productId =
    values.product ??
    (await pool.query<{ id: string }>('INSERT INTO products (name) VALUES ($1) RETURNING id', [values['product-name']])).rows[0]!.id;
  const { key, secret } = await createApiKey(pool, productId, values.label);
  console.log(`product: ${productId}\nkey:     ${key}\nsecret:  ${secret}\n\nThe secret is not stored and cannot be shown again.`);
} finally {
  await pool.end();
}
