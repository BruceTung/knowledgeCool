/**
 * 「还有没落库的改动」的**模块级登记表**。
 *
 * ## 它解决的是什么
 *
 * 编辑器的待保存状态原本完全封在组件里(`editSeq` / `savedSeq` 两个 ref)。
 * 这在"自己管自己"的场景下够用,但**登出发生在别处**(顶栏的 `AppLayout`)——
 * 那里没有任何办法问一句"现在还有没有字没存上去"。
 *
 * 于是登出走的是一条致命的顺序(`AppLayout` 里 `onSettled` 才导航):
 *   1. 先发出 `POST /auth/logout`;
 *   2. 服务端**当场吊销 Cookie / 删掉会话行**;
 *   3. 请求返回(**即使它失败也会走 `onSettled`**)→ 导航 → 编辑器卸载;
 *   4. 卸载补保存这一刻才发出 —— 而**凭证已经没了** → 401 → 字丢了。
 *
 * 而且登出是**程序化导航**,绕过了 `beforeunload`:`NodeDetailPage` 里那个
 * "返回"链接会先弹确认,顶栏的"登出"却一路静默 —— 两条离开路径行为不一致,
 * 用户当然会以为"登出总是安全的"。
 *
 * ## 怎么用
 *
 * 编辑器挂载时 `register`,卸载时 `unregister`,登记的是它自己的 `flush`。
 * 需要"先冲刷再继续"的地方(目前是登出)调 `flushAllPendingSaves()`,
 * 它会**逐个 await**。
 *
 * ## 为什么失败是"返回数量"而不是抛异常
 *
 * 调用方的情况不一样:登出**必须**能继续(用户点了登出就得让他登出,
 * 不能被一次网络故障困在里面),但要**知道**有东西没冲掉,好据此确认一次。
 * 所以这里如实返回"没冲掉的条数",由调用方决定怎么办 ——
 * 不替它决定"失败就算了"。
 *
 * ⚠️ 注意 `beforeunload` 那条 `sendBeacon` 路径**不受本机制保护**:
 * 页面正在卸载,任何人都 await 不了。那一条只能继续靠 beacon(见 `PageEditor`),
 * 本文件只覆盖"应用还活着、只是要换页/登出"的情况。
 */

/** 一个还没落库的编辑器的冲刷入口。返回 `true` 表示这次真的冲干净了。 */
export type PendingSaveFlusher = () => Promise<boolean>;

const flushers = new Set<PendingSaveFlusher>();

/**
 * 登记一个"可能还有未保存改动"的冲刷函数,返回**注销**函数。
 *
 * 返回注销函数而不是让调用方自己 `unregister`:后者很容易在重构里漏掉,
 * 而漏掉的后果是**内存泄漏 + 冲刷一个已卸载的编辑器**。
 * 直接用 `useEffect` 的返回值承接即可:
 *
 * ```ts
 * useEffect(() => registerPendingSave(() => flushRef.current?.() ?? Promise.resolve(true)), []);
 * ```
 */
export function registerPendingSave(flush: PendingSaveFlusher): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/**
 * 冲刷**全部**登记项。返回没能冲干净的条数(`0` = 全都安全)。
 *
 * 逐个 `await` 而不是 `Promise.all`:这些冲刷大多会打同一个后端,
 * 并发发出去只会互相制造 409(§7.5 的乐观锁就是按顺序设计的)。
 * 登记项之间彼此独立,串行唯一的代价是慢一点 —— 而这条路径上
 * "正确"比"快"重要得多。
 */
export async function flushAllPendingSaves(): Promise<number> {
  let failed = 0;
  for (const flush of [...flushers]) {
    try {
      if (!(await flush())) failed += 1;
    } catch {
      // 冲刷本身抛异常也算失败 —— 不能因为一个编辑器报错就放弃其余,
      // 更不能让登出被它卡住。
      failed += 1;
    }
  }
  return failed;
}

/** 仅用于测试/断言:当前登记了多少个冲刷函数。 */
export function pendingSaveCount(): number {
  return flushers.size;
}
