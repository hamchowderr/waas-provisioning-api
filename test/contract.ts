// Checks responses against the public contract (openapi/waas-provisioning-api.yaml): the status code
// is listed for the operation, the content type matches, and the body matches the schema. Shared by
// the Phase 1 and Phase 2 contract tests.
import { expect } from 'vitest';
import { createAjv, spec } from '../src/openapi.ts';

export type Method = 'get' | 'post' | 'put' | 'delete';
export type Operation = { method: Method; path: string; operationId: string; phase: number };

export const operations: Operation[] = Object.entries(spec.paths).flatMap(([path, item]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.entries(item as Record<string, any>)
    .filter(([, op]) => op?.['x-phase'])
    .map(([method, op]) => ({ method: method as Method, path, operationId: op.operationId, phase: op['x-phase'] })),
);

export const operation = (operationId: string) => operations.find((o) => o.operationId === operationId)!;

/** A checker that records every "operationId status" it has seen, so a test can ask what was covered. */
export function contractChecker() {
  // Strict: no removeAdditional, so unknown response fields fail (the schemas set additionalProperties: false).
  const ajv = createAjv();
  const checked = new Set<string>();

  async function expectContract(operationId: string, res: Response): Promise<unknown> {
    const op = operation(operationId);
    const declared = spec.paths[op.path][op.method].responses[String(res.status)];
    expect(declared, `${operationId} returned ${res.status}, which the contract does not list`).toBeDefined();
    checked.add(`${operationId} ${res.status}`);
    if (!declared.content) return undefined;
    const contentType = res.headers.get('content-type') ?? '';
    const entries = Object.entries(declared.content) as [string, { schema: object }][];
    const match = entries.find(([type]) => contentType.startsWith(type));
    expect(match, `${operationId} ${res.status}: content type ${contentType} is not in the contract`).toBeDefined();
    const [type, media] = match!;
    if (type !== 'application/json') return new Uint8Array(await res.arrayBuffer());
    const body = await res.json();
    const schema = JSON.parse(JSON.stringify(media.schema).replaceAll('"#/components', '"spec#/components'));
    const validate = ajv.compile(schema);
    expect(validate(body), `${operationId} ${res.status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    return body;
  }

  return { expectContract, checked };
}
