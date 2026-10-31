/**
 * The sizes a store comes in (tenants.size). A size sets what the store's WordPress container may use and the
 * quotas the store's plan mu-plugin enforces (agent.php): storage counts wp-content and the database, and email
 * counts what WordPress sends in a calendar month (UTC). Measured on the store server; the database and agent
 * containers are the same for every size (compose.ts). assistantMessagesPerMonth caps the website assistant's
 * messages for the store in a calendar month (UTC), counted by the API (src/assistant-usage.ts).
 */
export const SIZES = {
  small: { cpus: 1, mem: '512m', workers: 8, storageGb: 5, emailsPerMonth: 5000, assistantMessagesPerMonth: 150 },
  medium: { cpus: 2, mem: '512m', workers: 16, storageGb: 10, emailsPerMonth: 20000, assistantMessagesPerMonth: 300 },
  large: { cpus: 4, mem: '768m', workers: 32, storageGb: 25, emailsPerMonth: 50000, assistantMessagesPerMonth: 600 },
} as const;

export type Size = keyof typeof SIZES;

/** What a store gets when its size is not given, and what stores created before sizes run as. */
export const DEFAULT_SIZE: Size = 'small';

export const isSize = (value: unknown): value is Size => typeof value === 'string' && Object.hasOwn(SIZES, value);
