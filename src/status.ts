/** The contract's statusCode values for tenants, versions and snapshots. */
export const Status = { Pending: 0, Done: 1, Failed: 2, Removing: 3 } as const;
export type StatusCode = (typeof Status)[keyof typeof Status];

const names = ['Pending', 'Done', 'Failed', 'Removing'] as const;

export function statusName(code: number): string {
  const name = names[code];
  if (!name) throw new Error(`Unknown status code ${code}`);
  return name;
}
