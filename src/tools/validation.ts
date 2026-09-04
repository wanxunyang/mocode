import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import type { Tool } from './types.js';

export type ToolArgumentValidation =
  | { valid: true }
  | { valid: false; code: 'INVALID_ARGUMENTS' | 'INVALID_TOOL_SCHEMA'; message: string };

type CachedValidator = { valid: true; validate: ValidateFunction } | { valid: false; message: string };

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
  const preferred =
    typeof schema.$schema === 'string' && schema.$schema.includes('2020-12')
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

function formatErrors(errors: ErrorObject[] | null | undefined, schema?: Record<string, unknown>): string {
  if (!errors?.length) return '参数不符合 JSON Schema';
  // 收集所有「缺少必填字段」涉及的属性名,用于在文末一次性列出完整必填签名,
  // 避免模型只补齐报错点名的一个字段、下一次又把别的字段弄丢(乒乓失败)。
  const missing = errors
    .filter((e) => e.keyword === 'required')
    .map((e) => String((e.params as { missingProperty?: unknown }).missingProperty ?? '?'));
  const body = errors
    .slice(0, 5)
    .map((error) => {
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
    })
    .join('; ');

  let hint = '';
  const required = (schema?.required as string[] | undefined) ?? [];
  const properties = (schema?.properties as Record<string, { description?: string }> | undefined) ?? {};
  if (missing.length > 0 && required.length > 0) {
    const lines = required.map((k) => `- ${k}: ${properties[k]?.description ?? '(无描述)'}`).join('\n');
    hint = `。请一次性补齐全部必填参数,不要在重试时只补其中一部分:\n${lines}`;
  }
  return body + hint;
}

/** Validate after tool-local normalization; AJV itself never coerces or mutates arguments. */
export function validateToolArguments(tool: Tool, args: unknown): ToolArgumentValidation {
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
    message: formatErrors(compiled.validate.errors, tool.parameters),
  };
}
