import { readFileSync } from 'node:fs';
import { Ajv, type Options, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { badRequest } from './errors.ts';

export const specPath = new URL('../openapi/waas-provisioning-api.yaml', import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const spec: any = parse(readFileSync(specPath, 'utf8'));

/** An Ajv instance holding the contract's component schemas under the id "spec". */
export function createAjv(options: Options = {}): Ajv {
  // strict: false because the spec carries OpenAPI-only keywords (example, x-phase, deprecated).
  const ajv = new Ajv({ strict: false, allErrors: true, ...options });
  addFormats.default(ajv);
  ajv.addSchema({ components: spec.components }, 'spec');
  return ajv;
}

// Request bodies: drop fields the contract doesn't define instead of rejecting them,
// as WPCS (a .NET API) did. Types and required fields are still enforced.
const requestAjv = createAjv({ removeAdditional: true });
const validators = new Map<string, ValidateFunction>();

export function validateBody<T>(schemaName: string, body: unknown): T {
  let validate = validators.get(schemaName);
  if (!validate) {
    validate = requestAjv.getSchema(`spec#/components/schemas/${schemaName}`);
    if (!validate) throw new Error(`No schema ${schemaName} in the contract`);
    validators.set(schemaName, validate);
  }
  if (!validate(body)) {
    throw badRequest(requestAjv.errorsText(validate.errors, { dataVar: 'body' }));
  }
  return body as T;
}
