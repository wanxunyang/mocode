/**
 * Tool results are still strings for LLM compatibility. Keep error detection
 * language-independent while legacy built-ins are migrated to structured results.
 */
export function isToolErrorOutput(output: string): boolean {
  return /^(?:错误|Error):/.test(output.trimStart());
}
