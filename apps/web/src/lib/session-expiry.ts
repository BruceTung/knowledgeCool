/**
 * 会话过期的**中央处理**。
 *
 * ## 为什么需要它
 *
 * 在这之前,全应用**唯一**的 401 处理在 `RequireAuth` —— 而它只看 `me` 这个查询
 * **自己**失败。会话在"人正在编辑"的过程中过期时,`me` 早就成功返回、被缓存住了,
 * 它不会再失败一次,于是没有任何人注意到。
 *
 * 表现出来是这样(实测于编辑器):
 *
 *   · 自动保存 401 → 编辑器把它当成一次普通的保存失败 →
 *     横幅上写「保存失败。内容还留在编辑器里,**继续输入会自动重试**」;
 *   · 而它**永远不会成功** —— 每一次重试都还是 401;
 *   · 用户按那句话一直输入,以为系统在帮他重试,直到关掉页面,**字全丢**。
 *
 * 更糟的是那句话本身是**对的**——对网络抖动确实会重试成功,
 * 所以用户没有任何线索去怀疑"其实是我掉线了"。
 *
 * ## 怎么用
 *
 * `main.tsx` 把 `onSessionExpired` 注册进 QueryClient 的全局 `onError`(查询与变更
 * 各一处),于是**任何**请求拿到 `UNAUTHORIZED` 都会走到这里一次。
 * 这个模块本身不依赖 React、也不依赖路由 —— 它只负责"记住发生了什么、通知订阅者"。
 *
 * ## 为什么不做成"直接跳登录页"
 *
 * 跳走会把**正在编辑的内容一起带走**。所以这里的策略是**两段式**:
 *   1. 立刻让界面如实说明"会话已过期"(而不是那句会骗人的"会自动重试");
 *   2. 由界面提供"重新登录"入口,并在跳转前把未保存内容留在本地。
 * 换言之:**先保住内容,再谈身份**。
 */

import { useSyncExternalStore } from 'react';

import { ApiError } from './api';

/** 会话过期后,界面要展示的状态。 */
export interface SessionExpiredState {
  /** 发生了什么(用于提示文案)。 */
  since: number;
}

let expiredAt: number | null = null;
const listeners = new Set<(state: SessionExpiredState | null) => void>();

/** 标记"会话已过期"。重复调用只记第一次 —— 一堆并发请求会一起 401。 */
export function markSessionExpired(): void {
  if (expiredAt !== null) return;
  expiredAt = Date.now();
  notify();
}

/** 会话重新可用(例如重新登录成功)时清掉标记。 */
export function clearSessionExpired(): void {
  if (expiredAt === null) return;
  expiredAt = null;
  notify();
}

/** 当前是否处于"会话已过期"状态。 */
export function isSessionExpired(): boolean {
  return expiredAt !== null;
}

/**
 * 订阅状态变化。返回**取消订阅**函数 —— 直接交给 `useEffect` 的返回值。
 */
export function subscribeSessionExpired(
  listener: (state: SessionExpiredState | null) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  const state = expiredAt === null ? null : { since: expiredAt };
  for (const listener of [...listeners]) listener(state);
}

/**
 * 这个错误是"会话过期"吗?
 *
 * ⚠️ 只认 `ApiError` 且码为 `UNAUTHORIZED` —— **不要**顺手把
 * 网络错误(fetch 抛 `TypeError`)也算进来:那会让人在网络抖一下之后
 * 就被提示"请重新登录",而实际上登录状态好好的。
 */
export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'UNAUTHORIZED';
}

/**
 * 给 TanStack Query 用的全局错误处理:**任何**查询/变更拿到 401 都记一次。
 *
 * 返回 `true` 表示"这是一个会话过期错误,已处理" —— 调用方据此决定
 * 是否还要弹自己的错误提示(通常就不该弹了,否则用户会同时看到
 * "请重新登录"和"保存失败"两条互相矛盾的提示)。
 */
export function handleQueryError(error: unknown): boolean {
  if (!isSessionExpiredError(error)) return false;
  markSessionExpired();
  return true;
}
/**
 * 给 React 组件用的订阅钩子:会话过期时返回 `true`。
 *
 * ⚠️ 用 `useSyncExternalStore` 而不是 `useState` + `useEffect` ——
 * 后者在**订阅建立之前**就已经过期的场景下会漏掉那一次(状态在挂载前就变了,
 * 而 effect 只监听之后的变化)。这个模块的状态是**模块级**的,
 * 天生就存在"组件挂载时它已经是过期状态"这种情况。
 */
export function useSessionExpired(): boolean {
  return useSyncExternalStore(
    (listener) =>
      subscribeSessionExpired(() => {
        listener();
      }),
    () => isSessionExpired(),
    // SSR 快照:这个应用不做 SSR,给同样的值即可
    () => false,
  );
}
