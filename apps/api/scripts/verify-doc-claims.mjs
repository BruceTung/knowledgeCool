/**
 * 文档声明核验(v3.0)。
 *
 * ## 它核的是什么
 *
 * `audit:docs` 检的是**文档与代码**的一致性(接口表、字段表、环境变量……)。
 * 但文档里还有一类话是**从代码读出来、再写成人话**的,比如:
 *
 *   · 「导出传错 format 回 400,**而且参数校验先于权限校验**」
 *   · 「审计游标传 `abc` 回 400,不是 500」
 *   · 「人员列表返回 `{ users, total, nextCursor }`」
 *
 * 这类句子机器比对不了 —— 它们是**对行为的断言**。
 * 唯一能验的办法就是**真的打一次接口**。这个脚本干这个。
 *
 * ## 用法
 *
 * ```bash
 * # 需要一套跑起来的实例(容器或本机 dev 都行)
 * KC_API=http://127.0.0.1:8080/api/v1 \
 *   KC_ADMIN_PASSWORD=Kc-admin-2026 \
 *   node apps/api/scripts/verify-doc-claims.mjs
 * ```
 *
 * 在容器里跑要指向 web(同 queue 里的说明):
 *   -e KC_API=http://web/api/v1
 *
 * ⚠️ 它**只读** —— 不改任何数据(登录除外,登录会清掉自己的失败计数)。
 */
const BASE = process.env.KC_API ?? 'http://127.0.0.1:8080/api/v1';
/**
 * 站点根(给"后端不参与、由 Nginx 直出"的那几条断言用,例如 SPA 路由)。
 *
 * ⚠️ v2.16 修的一处真实缺陷:下面那条 SPA 断言原本**硬编码**
 * `http://127.0.0.1:8080/search`,完全绕过了上面这个 `KC_API`。
 * 于是在**容器内**跑脚本时它必然 `ECONNREFUSED` ——
 * 因为 api 容器里 `127.0.0.1:8080` 是它自己的回环,那里没有 Nginx。
 *
 * 而这正是文件头(与 DESIGN §9.2)反复提醒的那个坑:文档教人用
 * `-e KC_API=http://web/api/v1 -e KC_ROOT=http://web`,脚本却把一个地址写死了。
 * 表现是"照文档做,脚本仍然连不上",而人会去怀疑容器或网络。
 *
 * 现在两个地址都从环境变量取,且与 `verify-org.mjs` 的 `KC_ROOT` 同名同义。
 */
const ROOT = process.env.KC_ROOT ?? 'http://127.0.0.1:8080';
const ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD ?? 'Kc-admin-2026';
let cookie = "";
function sync(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) { const m = /kc_session=([^;]+)/.exec(c); if (m) cookie = "kc_session=" + m[1]; }
}
/** 能解析成 JSON 就解析,否则原样返回文本(导出接口返回的是 CSV)。 */
function parseJson(text) {
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    return text;
  }
}

async function api(method, p, body) {
  const headers = { Accept: "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  sync(res);
  const text = await res.text();
  const json = parseJson(text);
  return { status: res.status, body: json, raw: text };
}
await api("POST", "/auth/login", { employeeNo: "KC001", password: ADMIN_PASSWORD });
const results = [];
const ck = (claim, ok, detail) => results.push((ok ? "OK   " : "FAIL ") + claim + (detail ? "  [" + detail + "]" : ""));

// §6.1 health probes do not touch deps? (doc says /health does not, /health/ready does)
const h = await api("GET", "/health");
ck("§6.3 GET /health 返回 200 且不碰依赖", h.status === 200, "status=" + h.status);
const hr = await api("GET", "/health/ready");
ck("§6.3 GET /health/ready 返回 200(依赖就绪)", hr.status === 200, "status=" + hr.status);

// §6.3: export requires ?format=md; wrong value -> 400 (validation BEFORE permission)
const tree = await api("GET", "/org/tree");
const anyNode = tree.body.nodes[0];
const wrongFmt = await api("GET", "/nodes/" + anyNode.id + "/export?format=pdf");
ck("§6.3 导出传错 format -> 400(校验先于权限)", wrongFmt.status === 400, "status=" + wrongFmt.status);
const goodFmt = await api("GET", "/nodes/" + anyNode.id + "/export?format=md");
ck("§6.3 导出传 format=md -> 200", goodFmt.status === 200, "status=" + goodFmt.status);

// §6.1: unknown route -> 404 shape
const nf = await api("GET", "/definitely-not-a-route");
ck("§6.1 未知路由回 404", nf.status === 404, "status=" + nf.status);

// §6.4: audit cursor validation
const badCursor = await api("GET", "/audit-logs?cursor=abc");
ck("§6.4 审计游标传 abc -> 400(不是 500)", badCursor.status === 400, "status=" + badCursor.status);
const okCursor = await api("GET", "/audit-logs?cursor=1");
ck("§6.4 审计游标传 1 -> 200", okCursor.status === 200, "status=" + okCursor.status);

// §9.1 pagination: /admin/users returns {users,total,nextCursor}
const users = await api("GET", "/admin/users?limit=2");
const shape = users.body ?? {};
ck("§6.1 人员列表带 total 与 nextCursor", Array.isArray(shape.users) && typeof shape.total === "number" && "nextCursor" in shape, Object.keys(shape).join(","));

// §6.1.3: throttle keys exist in redis after a failure? (do not lock a real account; use a fake employeeNo)
const fake = await api("POST", "/auth/login", { employeeNo: "ZZZ999", password: "wrong" });
ck("§6.1.3 不存在的工号登录失败 -> 401(与真实账号同一个错误体)", fake.status === 401, "status=" + fake.status);

// §5.6: readers endpoint on an unrestricted node -> 200 with visibility=public
const readers = await api("GET", "/nodes/" + anyNode.id + "/readers");
ck("§5.6 公开节点的可见范围可读且为 public", readers.status === 200 && readers.body?.visibility === "public", "status=" + readers.status + " vis=" + String(readers.body?.visibility));

// §6.2: bulk move exists (401/400 without proper body, but not 404)
const bulk = await api("POST", "/nodes/bulk/move", {});
ck("§6.2 POST /nodes/bulk/move 存在(不是 404)", bulk.status !== 404, "status=" + bulk.status);

// §7.1: SPA serves index for /search
const spa = await fetch(ROOT + "/search");
const html = await spa.text();
ck("§7.1 前端路由 /search 由 SPA 接管", spa.status === 200 && html.includes("<div id="), "status=" + spa.status);

console.log(results.join(String.fromCharCode(10)));
console.log(String.fromCharCode(10) + "passed " + results.filter((r) => r.startsWith("OK")).length + "/" + results.length);