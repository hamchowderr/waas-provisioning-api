-- The products the platform itself uses: the seller storefront template and the store template every new
-- seller's product copies. Set once (src/platformproducts.ts copies STOREFRONT_PRODUCT_ID and
-- STORE_TEMPLATE_PRODUCT_ID here on start), so those settings can then be left out.
CREATE TABLE platform_products (
  role        text PRIMARY KEY CHECK (role IN ('storefront-template', 'store-template')),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
