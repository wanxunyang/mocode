import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import type { Tool } from './types.js';

export type ToolArgumentValidation =
  | { valid: true }
  | { valid: false; code: 'INVALID_ARGUMENTS' | 'INVALID_TOOL_SCHEMA'; message: string };

type CachedValidator =
  | { valid: true; validate: ValidateFunction }
  | { valid: false; message: string };

const options = {
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateFormats: false,
  allowUnionTypes: true,
} as const;
const draft7 = new Ajv(options);
const draft2020 = new Ajv2020(options);
const cache = new WeakMap<object, CachedValidator>();

function compile(schema: Record<string, unknown>): CachedValidator {
  const cached = cache.get(schema);
  if (cached) return cached;
  const preferred = typeof schema.$schema === 'string' && schema.$schema.includes('2020-12')
    ? [draft2020, draft7]
    : [draft7, draft2020];
  let lastError: unknown;
  for (const ajv of preferred) {
    try {
      const result = { valid: true as const, validate: ajv.compile(schema) };
      cache.set(schema, result);
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  const result = {
    valid: false as const,
    message: lastError instanceof Error ? lastError.message : String(lastError),
  };
  cache.set(schema, result);
  return result;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return '参数不符合 JSON Schema';
  return errors.slice(0, 5).map((error) => {
    const location = error.instancePath || '/';
    if (error.keyword === 'required') {
      const property = String((error.params as { missingProperty?: unknown }).missingProperty ?? '?');
      return `${location} 缺少必填字段 ${JSON.stringify(property)}`;
    }
    if (error.keyword === 'additionalProperties') {
      const property = String((error.params as { additionalProperty?: unknown }).additionalProperty ?? '?');
      return `${location} 含未知字段 ${JSON.stringify(property)}`;
    }
    return `${location} ${error.message ?? error.keyword}`;
  }).join('; ');
}

/** Validate after tool-local normalization; AJV itself never coerces or mutates arguments. */
export function validateToolArguments(
  tool: Tool,
  args: unknown,
): ToolArgumentValidation {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      valid: false,
      code: 'INVALID_ARGUMENTS',
      message: '参数根节点必须是 JSON object',
    };
  }

  try {
    tool.normalizeArguments?.(args as Record<string, unknown>);
  } catch (error) {
    return {
      valid: false,
      code: 'INVALID_ARGUMENTS',
      message: `参数规范化失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const compiled = compile(tool.parameters);
  if (!compiled.valid) {
    return {
      valid: false,
      code: 'INVALID_TOOL_SCHEMA',
      message: `工具 schema 无法编译: ${compiled.message}`,
    };
  }
  if (compiled.validate(args)) return { valid: true };
  return {
    valid: false,
    code: 'INVALID_ARGUMENTS',
    message: formatErrors(compiled.validate.errors),
  };
}
