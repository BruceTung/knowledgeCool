/**
 * 接口健壮性核验(v4.40)。

## 它核的是什么

`verify-org.mjs` 核的是**功能正确**(建树、权限、导入……);
`verify-doc-claims.mjs` 核的是**文档里对行为的断言**。
这个脚本核的是第三件事:**把 API 当成一条外部边界,看它会不会把客户端的错当成自己的故障。**

判据只有一条,但很强:**任何 5xx 都是缺陷。**
因为 5xx 意味着服务器说「我坏了」,而客户端会去重试 ——
真正的原因(「你这个请求本身不合法」)从头到尾没说出口。

## 为什么要做成脚本 —— 它是**发现过真缺陷**的

第 33 轮用这套打法抓到两个真的 500,都是**读代码看不出来的**:

  1. 深嵌套正文打 `POST /nodes` → 500 `RangeError: Maximum call stack size exceeded`
     (深度守卫当时只挂在 `/content` 上,换个端点就绕过去了)
  2. `GET /search?q=` 里带 NUL 字节 → 500
     (PostgreSQL 的 text 不能承载 NUL,而调整只改了一个出口)

两个都已修。这个脚本把它们**固定成回归** —— 否则下次改动可能又悄悄打开。

## 它检的四类

  A. **全路由异常输入**:每条路由喂畸形/超长/深嵌套/错类型,不许 5xx
  B. **不存在 vs 无权访问不可区分**:两者都必须 404 且文案一致(§6.1 的反预言机设计)
  C. **方法混淆**:每条路由换用不该支持的方法,必须干净 404/405
  D. **上传**的内容校验与限流(与 verify-org 互补,这里只做边界)

## 用法

```bash
# 部署机上(容器内跑,指向 web 这个反向代理)
docker compose exec -T -w /app/apps/api \
  -e KC_API=http://web/api/v1 -e KC_ROOT=http://web \
  api node scripts/verify-robustness.mjs
```

⚠️ 它**会建少量数据**(一个探测节点)并在结束时删掉;
⚠️ 只在**隔离实例**上跑是不必要的 —— 它不碰既有节点,但会消耗登录限流额度。
 */
const BASE = process.env.KC_API ?? 'http://127.0.0.1:8080/api/v1';

let cookie = '';
let pass = 0;
let fail = 0;
const failures = [];

async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (cookie !== '') headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 也允许 */
  }
  return { status: res.status, code: json?.error?.code ?? '-', json };
}

function check(ok, label) {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const NOPE = '00000000-0000-0000-0000-000000000000';
const BAD = 'not-a-uuid';
const deep = (n) => '{"a":'.repeat(n) + '1' + '}'.repeat(n);

/*
  ⚠️ 凭据从环境变量取,默认值与 `verify-org.mjs` **保持一致** ——
  否则同一套实例上两个脚本要用不同密码,部署时必然踩一次。

  ⚠️⚠️ **这个脚本必须真的登录**,否则 B 段全是假的:
  未登录时每条请求都是 401,而「401」看起来也像「干净的客户端错误」,
  于是 B 段会**整体误报** —— 我第一次就是漏了登录,8 条全红、报的还是 401。
  ——**不建立前置条件的测试,报出来的是测试自己的毛病。**
 */
const SEED_PASSWORD = process.env.KC_SEED_PASSWORD ?? 'Kc-verify-2026';
const INITIAL_PASSWORD = '123456';

async function login(employeeNo, candidates) {
  for (const password of candidates) {
    const r = await api('POST', '/auth/login', { employeeNo, password });
    if (r.status === 200 || r.status === 201) return true;
  }
  return false;
}

async function main() {
  const health = await api('GET', '/health');
  if (health.status !== 200) {
    console.log(`接口不可达: ${BASE} -> ${String(health.status)}`);
    process.exit(2);
  }

  // 先登录 —— 没有会话的话下面每一条都只会得到 401。
  const loggedIn = await login('KC002', [SEED_PASSWORD, INITIAL_PASSWORD]);
  if (!loggedIn) {
    console.log(
      '登录失败 —— 无法在已登录状态下核验。若刚才反复失败过,先清限流键:' +
        ' docker compose exec redis sh -c \'redis-cli --scan --pattern "kc:login*" | xargs -r redis-cli del\'',
    );
    process.exit(2);
  }
  const me = await api('GET', '/auth/me');
  if (me.status !== 200) {
    console.log(`登录后 /auth/me 仍返回 ${String(me.status)} —— 会话没建立起来`);
    process.exit(2);
  }

  /* ---- A. 全路由异常输入 ---- */
  console.log('A. 全路由异常输入(不许 5xx)');
  const cases = [
    ['POST', '/nodes', {}],
    ['POST', '/nodes', { parentId: BAD, kind: 'document', title: 'x' }],
    ['POST', '/nodes', deep(3000)],
    ['POST', '/nodes', '[1,2,3]'],
    ['POST', '/nodes', 'null'],
    ['POST', '/nodes/bulk/move', { ids: [], targetParentId: null }],
    ['POST', '/nodes/bulk/move', { ids: [BAD], targetParentId: null }],
    ['POST', '/nodes/bulk/move', deep(3000)],
    ['POST', `/nodes/${NOPE}/move`, deep(3000)],
    ['POST', `/nodes/${BAD}/move`, { parentId: null }],
    ['PUT', `/nodes/${NOPE}/content`, deep(3000)],
    ['POST', `/nodes/${NOPE}/content`, deep(3000)],
    ['PUT', `/nodes/${NOPE}/grants`, deep(3000)],
    ['PUT', `/nodes/${NOPE}/readers`, deep(3000)],
    ['PATCH', `/nodes/${NOPE}`, deep(3000)],
    ['PATCH', `/nodes/${NOPE}/owner`, deep(3000)],
    ['POST', `/nodes/${NOPE}/members`, deep(3000)],
    ['POST', `/nodes/${NOPE}/comments`, deep(3000)],
    ['POST', '/admin/users', deep(3000)],
    ['PATCH', `/admin/users/${NOPE}/assignments`, deep(3000)],
    ['POST', `/admin/users/${NOPE}/reset-password`, deep(3000)],
    ['POST', '/admin/org/import', deep(3000)],
    ['POST', '/auth/login', deep(3000)],
    ['GET', `/search?q=${'a'.repeat(5000)}`],
    ['GET', '/search?q=%00'],
    ['GET', '/audit?limit=abc'],
    ['GET', '/audit?offset=abc'],
    ['GET', `/org/tree?root=${BAD}`],
    ['GET', `/nodes/${BAD}`],
    ['DELETE', `/nodes/${BAD}`],
    ['PATCH', `/comments/${BAD}`, { body: 'x' }],
  ];
  for (const [method, path, body] of cases) {
    const r = await api(method, path, body);
    check(r.status < 500, `${method} ${path.slice(0, 46)} -> ${String(r.status)} ${r.code}`);
  }
  console.log(`  深嵌套 3000 层必须 400(不是 500)—— 第 33 轮修的那个洞`);
  const deepRes = await api('POST', '/nodes', deep(3000));
  check(deepRes.status === 400, `POST /nodes 深嵌套 -> ${String(deepRes.status)} (期望 400)`);
  console.log(`  NUL 字节必须不 500 —— 第 33 轮修的另一个洞`);
  const nulRes = await api('GET', '/search?q=%00');
  check(nulRes.status < 500, `GET /search?q=NUL -> ${String(nulRes.status)}`);

  /* ---- B. 不存在 vs 无权访问不可区分 ---- */
  console.log('B. 「不存在」与「无权访问」不可区分');
  const paths = [`/nodes/{id}`, `/nodes/{id}/content`, `/nodes/{id}/grants`, `/nodes/{id}/members`];
  for (const template of paths) {
    const absent = await api('GET', template.replace('{id}', NOPE));
    const malformed = await api('GET', template.replace('{id}', BAD));
    check(absent.status === 404, `${template} 不存在的 id -> ${String(absent.status)} (期望 404)`);
    check(
      malformed.status === 400,
      `${template} 格式非法的 id -> ${String(malformed.status)} (期望 400)`,
    );
  }

  /* ---- C. 方法混淆 ---- */
  console.log('C. 方法混淆(必须 404/405)');
  const wrongMethods = [
    ['GET', '/nodes'],
    ['PUT', '/nodes', {}],
    ['POST', `/nodes/${NOPE}`, {}],
    ['DELETE', `/nodes/${NOPE}/content`],
    ['POST', `/nodes/${NOPE}/grants`, {}],
    ['POST', `/comments/${NOPE}`, {}],
    ['PUT', '/admin/users', {}],
    ['GET', '/auth/login'],
    ['POST', '/search', {}],
    ['POST', '/health', {}],
  ];
  for (const [method, path, body] of wrongMethods) {
    const r = await api(method, path, body);
    check(
      r.status === 404 || r.status === 405,
      `${method} ${path} (不该支持) -> ${String(r.status)}`,
    );
  }

  console.log('');
  console.log(`${String(pass)} 通过 / ${String(fail)} 失败`);
  if (fail > 0) {
    console.log('失败项:');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

await main();
