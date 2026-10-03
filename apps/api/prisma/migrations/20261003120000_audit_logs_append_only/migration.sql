-- 审计表只增约束(2026-10-03)
--
-- 背景:`audit_logs` 此前**只靠约定**保证"只写不改不删" ——
-- 应用层没有 UPDATE / DELETE 它的代码,仅此而已。
-- 而这条约定有三重脆弱:
--   1. 它是**否定式**的(「没有代码这么做」),不是**肯定式**的(「数据库不准」);
--   2. 将来任何一次"数据迁移顺手改一下"或"给个后台加个清理功能"都可能破它;
--   3. 破了的**表现极坏**:审计是事后追责的唯一依据,被改过之后,
--      它仍然"看起来正常" —— 没有任何东西会报错,没人会察觉。
--
-- 为什么选触发器而不是 `REVOKE UPDATE, DELETE`:
--   Prisma 的迁移连接用的是**表所有者**(超级可用 `knowledgecool` 角色),
--   所有者**不受 REVOKE 约束** —— 对自己建的表 REVOKE 是不生效的。
--   换句话说 REVOKE 在这里会给出一个"看起来有防护、实际没有"的假安全感。
--   触发器是**无论谁执行都生效**的,所以用它。
--
-- ⚠️ 触发器会拦下**所有** UPDATE / DELETE,不做任何区分。
-- 这正是要的:审计表的"修改"与"删除"本来就没有合法用途。
-- 若将来真的要清理历史,正确做法是**归档到另一张表**再删,
-- 而不是就地 UPDATE —— 就地改过的审计等于没有审计。

-- ============================================================
-- 1) UPDATE 一律拒绝
-- ============================================================
CREATE OR REPLACE FUNCTION audit_logs_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs 只增不改:UPDATE 被拒绝(第 % 行, 原值 %)。审计被改过之后仍然"看起来正常",'
    '这比没有审计更坏。要清历史请归档到别处再删。',
    OLD.id, to_jsonb(OLD)
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_update();

-- ============================================================
-- 2) DELETE 一律拒绝
-- ============================================================
CREATE OR REPLACE FUNCTION audit_logs_reject_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs 只增不删:DELETE 被拒绝(删的是第 % 行, 共 % 列)。'
    '审计是事后追责的唯一依据,删掉它等于把这段历史抹了。'
    '要清历史请归档到别处再删。',
    OLD.id, (SELECT count(*) FROM information_schema.columns
              WHERE table_name = 'audit_logs' AND table_schema = 'public')
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_delete();

-- ============================================================
-- 3) TRUNCATE 也堵掉
-- ============================================================
-- ⚠️ 这一条**必须**有,否则前面两条形同虚设:
--   TRUNCATE 不触发行级 BEFORE trigger,它会**整表清空**并**静默成功**。
--   也就是说"有触发器保护审计表"这句话在 TRUNCATE 面前是假的。
--
-- 事件级触发器只能对 **TRUNCATE** 声明(不允许 FOR EACH ROW),
-- 而 PostgreSQL 要求它**不是**约束触发器 —— 所以只能加在语句级。
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_delete();
