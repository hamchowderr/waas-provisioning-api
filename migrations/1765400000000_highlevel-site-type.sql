-- Up Migration

-- A storefront of a HighLevel agency: its new sites get the store template's "highlevel" site type (src/routes/tenants.ts),
-- the website basics plus WP Fusion Lite and HighLevel's LeadConnector, without FluentCRM, Fluent Forms and the
-- other Fluent plugins HighLevel already does. Set when the AnyPress app for HighLevel calls the API for the storefront
-- (src/highlevel.ts), and here for the storefronts that already have it installed.
ALTER TABLE products ADD COLUMN highlevel_agency boolean NOT NULL DEFAULT false;

-- A storefront others follow (a store template, such as the shop's) is never one: its sites are the platform's own.
UPDATE products p SET highlevel_agency = true
WHERE NOT EXISTS (SELECT 1 FROM products f WHERE f.follows_product_id = p.id)
  AND (EXISTS (SELECT 1 FROM webhook_endpoints w WHERE w.product_id = p.id AND w.kind = 'highlevel')
   OR EXISTS (SELECT 1 FROM tenants t WHERE t.product_id = p.id AND t.highlevel_location_id IS NOT NULL)
   OR EXISTS (
     SELECT 1 FROM oauth_tokens o JOIN api_keys k ON k.id = o.api_key_id
     WHERE k.product_id = p.id AND o.resource LIKE '%/apps' AND o.revoked_at IS NULL
   ));

-- Their sites that were made with no site type have every plugin on (AnyPress Client switches nothing without one).
-- They get the HighLevel site type, pushed to each site once (src/constantnames.ts). Sites moved in keep their own code.
WITH typed AS (
  UPDATE tenants t SET php_constants = t.php_constants || '{"ANYPRESS_TENANT_ROLES": {"value": "highlevel", "isPrivate": false}}'::jsonb
  FROM products p
  WHERE p.id = t.product_id AND p.highlevel_agency AND NOT t.own_code AND t.status IN (0, 1)
    AND NOT (t.php_constants ? 'ANYPRESS_TENANT_ROLES')
  RETURNING t.id
)
INSERT INTO constant_renames (tenant_id) SELECT id FROM typed ON CONFLICT DO NOTHING;

-- Down Migration

ALTER TABLE products DROP COLUMN highlevel_agency;
