/**
 * computer 敏感内容审查的纯谓词(叶子模块,无任何运行时依赖)。
 *
 * 从 permissions/index.ts 拆出:flows/(trace、flow)要在录制/导出/回放前复用同一套判定,
 * 而 permissions/index.ts 反过来要读 flow 文件算 run_flow 的审查原因——谓词放叶子文件避免 import 环。
 * permissions/index.ts 会原样 re-export,既有调用方与测试不受影响。
 */

/**
 * computer 工具的 type/key 文本内容审查:
 * 命中 URL / 密码形态 / 支付关键词时,无论是否已授权都强制 once 级确认——
 * 这类文本是「把内容敲进任意应用」的载体,不能因 session/项目授权而放行后续所有输入。
 * 纯函数,独立可单测。
 */
export function computerTextNeedsReview(text: string): boolean {
  const s = text.toLowerCase();
  if (/https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}/i.test(s)) return true;
  if (/\b(pass(word)?|passwd|pwd|secret|token|api[_-]?key|credential)\b\s*[:=]/i.test(s)) return true;
  if (/\b(card\s*number|cvv|cvc|expiry)\b/i.test(s)) return true;
  // CJK 关键词没有 \b 词边界概念(\b 只在 \w 与非 \w 之间成立,中文不是 \w),用普通子串匹配。
  if (/信用卡|卡号|密码|支付|付款|验证码/.test(s)) return true;
  return false;
}

/**
 * computer click_element 目标元素名审查(design-notes/computer-use-rpa.md §2.6):
 * 名称命中删除/发送/提交/支付类关键词时强制 once 级确认——这类按钮一点即产生外部副作用,
 * 不能因为「本会话允许 click_element」而静默放行。纯函数,独立可单测。
 */
export function computerTargetNeedsReview(name: string): boolean {
  const s = name.toLowerCase();
  if (/\b(delete|remove|send|submit|pay|purchase|buy|checkout|confirm|transfer|uninstall|format|erase)\b/i.test(s)) {
    return true;
  }
  if (/删除|移除|发送|提交|支付|付款|购买|下单|确认|转账|卸载|格式化|清空/.test(s)) return true;
  return false;
}
