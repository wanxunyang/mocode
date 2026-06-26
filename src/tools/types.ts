/** 工具统一接口。每个工具是一个 name + JSON Schema + execute。 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: Record<string, unknown>) => Promise<string>;
}
