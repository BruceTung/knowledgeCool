/**
 * 请求体 JSON 的**深度守卫**。
 *
 * ## 为什么必须在**解析阶段**拦,而不是在业务校验里
 *
 * 这条是实测出来的,不是推测。把一份**深度递增**的正文发给
 * `PUT /nodes/:id/content`(内容都是合法的 `{type:'doc'}` 树):
 *
 * ```
 *   深度  500  (15 KB)  -> 403   <- 走到了业务校验
 *   深度 1000  (30 KB)  -> 500   <- 崩了
 *   深度 4000  (120 KB) -> 500
 *   浅结构、88 KB        -> 403   <- **同体积不崩**
 * ```
 *
 * **是「深」,不是「大」。** 而 500 的堆栈在:
 *
 * ```
 *   RangeError: Maximum call stack size exceeded
 *     at @nestjs/common/utils/strip-proto-keys.util.js:16
 * ```
 *
 * 也就是说崩溃发生在 **Nest 反序列化/剥离原型键**那一步 ——
 * 比任何控制器代码都早。`ContentService.save` 里那句
 * `checkDocStructure(input.content)` **永远不会被执行**:
 * 请求还没进到业务层就 500 了。
 *
 * 后果与原来一样糟(客户端看到「服务器内部错误」、只会重试,
 * 而真正的原因「内容结构有问题」从头到尾没说出口),但**修法完全不同**:
 * 必须挂在 body-parser 之前。
 */

/**
 * 在**解析之前**扫描原始 JSON 文本,判断嵌套深度是否超过 `maxDepth`。
 *
 * 只看括号层数,不建对象 —— 纯字符扫描、零分配、**不递归**,
 * 因此再深的输入也不会让它爆栈(这正是它存在的理由)。
 *
 * ⚠️ 必须跳过字符串字面量里的括号:`{"text":"{{{((("` 里的括号
 * 是**内容**不是结构,算进去会造成误判。所以扫描时要跟踪
 * 「是否在字符串内」与「是否被反斜杠转义」。
 *
 * ⚠️ 这是**廉价的第一道闸**,只管括号层数;真正的结构校验
 * (节点数、type=doc 等)仍在 `checkDocStructure` 里做 ——
 * 到那一步解析已经完成,递归/序列化都安全了。
 */
export function exceedsNestingDepth(raw: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > maxDepth) return true;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
  }
  return false;
}
