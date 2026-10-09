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
  // 中转网关/弱模型常把 integer/number/boolean 序列化成字符串(如 "100"),
  // 开启标量强转在校验前自动还原;类型完全不符("abc"→number)仍会被拦,
  // minimum/maximum 等约束在转换后照常生效。
  coerceTypes: true,
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

/** 弱模型/中转网关对嵌套结构不稳定的序列化产物:array/object 被整体 JSON.stringify
 * 成字符串塞进外层 JSON(如 plan_update {"steps":"[{...}]"},真实会话 2026-10-09)。
 * AJV coerceTypes 只覆盖标量(number/integer/boolean),不做 string→array/object 转换,
 * 模型会反复撞 "/steps must be array" 乒乓失败。
 *
 * 按 schema 声明反向还原:仅在字段声明为 array/object 且实际值是形似 JSON 的字符串
 * ([ 或 { 开头)且能成功 parse 出对应类型时替换;parse 失败/类型不符保持原值,
 * 照旧由 schema 校验报原始错误——不吞错误、不造数据。递归一层嵌套对象
 * (如 ask_human options、plan_update steps 的 items),数组元素本身不再深递归
 * (元素级偏差交给各工具自己的 normalizeArguments 别名归一)。
 */
function coerceStringifiedContainers(schema: Record<string, unknown> | undefined, args: Record<string, unknown>): void {
  const properties = schema?.properties as Record<string, unknown> | undefined;
  if (!properties) return;
  for (const [key, declared] of Object.entries(properties)) {
    const raw = args[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    const type = (declared as { type?: unknown }).type;
    const looksLike = type === 'array' ? trimmed.startsWith('[') : type === 'object' ? trimmed.startsWith('{') : false;
    if (!looksLike) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const typeMatches =
      type === 'array'
        ? Array.isArray(parsed)
        : typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    if (typeMatches) args[key] = parsed;
  }
  // 递归一层:已还原/本来就是 object 的字段,其属性级偏差同样还原(如 steps[i] 里的数组字段)。
  for (const [key, declared] of Object.entries(properties)) {
    const child = args[key];
    if (typeof child !== 'object' || child === null) continue;
    const childSchema = (declared as { properties?: unknown }).properties;
    if (childSchema && !Array.isArray(child)) {
      coerceStringifiedContainers(declared as Record<string, unknown>, child as Record<string, unknown>);
    }
    const itemSchema = (declared as { items?: unknown }).items;
    if (Array.isArray(child) && itemSchema && typeof itemSchema === 'object') {
      for (const element of child) {
        if (typeof element === 'object' && element !== null && !Array.isArray(element)) {
          coerceStringifiedContainers(itemSchema as Record<string, unknown>, element as Record<string, unknown>);
        }
      }
    }
  }
}

/** Validate after tool-local normalization; AJV coerces scalar strings to declared types. */
export function validateToolArguments(tool: Tool, args: unknown): ToolArgumentValidation {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      valid: false,
      code: 'INVALID_ARGUMENTS',
      message: '参数根节点必须是 JSON object',
    };
  }

  coerceStringifiedContainers(tool.parameters, args as Record<string, unknown>);

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
