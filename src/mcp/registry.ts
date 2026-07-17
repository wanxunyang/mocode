/**
 * 兼容旧的 MCP registry 导入路径；运行时注册逻辑集中在 index.ts。
 * 保留该叶子模块也便于测试在不读取环境配置时注入已握手 client。
 */
export { __testInjectClient } from './index.js';
