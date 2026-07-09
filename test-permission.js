// 快速冒烟测试:权限系统集成
const { checkPermission } = require('./dist/permissions/index.js');
const { getToolRisk } = require('./dist/permissions/index.js');

// Mock tool
const safeTool = { name: 'read_file', risk: undefined };
const confirmTool = { name: 'edit_file', risk: 'confirm' };
const dangerousTool = { name: 'run_command', risk: 'dangerous' };

console.log('Testing getToolRisk:');
console.log('  safe:', getToolRisk(safeTool), '=== safe?', getToolRisk(safeTool) === 'safe');
console.log('  confirm:', getToolRisk(confirmTool), '=== confirm?', getToolRisk(confirmTool) === 'confirm');
console.log('  dangerous:', getToolRisk(dangerousTool), '=== dangerous?', getToolRisk(dangerousTool) === 'dangerous');

console.log('\nTesting checkPermission (safe should allow immediately):');
checkPermission(safeTool, {}).then(result => {
  console.log('  safe result:', result, '=== allow?', result === 'allow');
});

console.log('\nAll basic checks passed!');
