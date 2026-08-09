import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(
  join(repositoryRoot, 'native', 'product-core', 'schema', 'diagnostic-result.v1.json'),
  'utf8',
));
const allowedFields = new Set(schema.allowedFields);
const requiredFields = new Set(schema.requiredFields);

export function assertSanitizedDiagnosticResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('diagnostic result must be an object');
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(result, field)) throw new Error(`missing diagnostic result field: ${field}`);
  }
  const stack = [result];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value.filter(item => item && typeof item === 'object'));
      continue;
    }
    for (const [field, nested] of Object.entries(value)) {
      if (!allowedFields.has(field)) throw new Error(`forbidden diagnostic result field: ${field}`);
      if (nested && typeof nested === 'object') stack.push(nested);
    }
  }
  if (!schema.statusValues.includes(result.status)) throw new Error(`unknown diagnostic status: ${result.status}`);
  if (!schema.profileValues.includes(result.profile)) throw new Error(`unknown diagnostic profile: ${result.profile}`);
  if (result.measurements.length > schema.limits.measurementsMax) throw new Error('too many diagnostic measurements');
  if (result.evidence.length > schema.limits.evidenceMax) throw new Error('too many diagnostic evidence entries');
  return result;
}

export const diagnosticResultSchema = Object.freeze(schema);
