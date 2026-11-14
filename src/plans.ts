/**
 * The sizes a store comes in (tenants.size). A size sets what the store's WordPress container may use and the
 * quotas the store's plan mu-plugin enforces (agent.php): storage counts wp-content and the database, and email
 * counts what WordPress sends in a calendar month (UTC). Measured on the store server; the database and agent
 * containers are the same for every size (compose.ts). assistantMessagesPerMonth caps the website assistant's
 * messages for the store in a calendar month (UTC), counted by the API (src/assistant-usage.ts). voiceMinutesPerMonth
 * caps the phone receptionist's answered call minutes the same way (src/voice.ts).
 */
export const SIZES = {
  small: { cpus: 1, mem: '768m', workers: 8, storageGb: 10, emailsPerMonth: 5000, assistantMessagesPerMonth: 150, voiceMinutesPerMonth: 100 },
  medium: { cpus: 2, mem: '1280m', workers: 16, storageGb: 20, emailsPerMonth: 20000, assistantMessagesPerMonth: 300, voiceMinutesPerMonth: 250 },
  large: { cpus: 4, mem: '2048m', workers: 32, storageGb: 30, emailsPerMonth: 50000, assistantMessagesPerMonth: 600, voiceMinutesPerMonth: 500 },
} as const;

export type Size = keyof typeof SIZES;

/** The storage one storage pack adds to a store's plan, in GB (tenants.storage_packs, src/routes/lifecycle.ts). */
export const STORAGE_PACK_GB = 25;

/** What a store gets when its size is not given, and what stores created before sizes run as. */
export const DEFAULT_SIZE: Size = 'small';

export const isSize = (value: unknown): value is Size => typeof value === 'string' && Object.hasOwn(SIZES, value);
