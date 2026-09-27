/**
 * 代码块的语言选择(v2.10)。
 *
 * 只在光标位于代码块内时出现 —— 放在工具栏里而不是每块代码上悬浮,
 * 是因为"一次只会选一个语言",挂在块上会让每块都多一行控件。
 *
 * ## 两个细节
 *
 * 1. **存的可能是别名**(从别处粘进来的 ` ```js `)。下拉的值必须是规范 id
 *    (`javascript`),否则 `<select>` 匹配不到 option,显示成空白 ——
 *    用户会以为"语言丢了",其实只是没人把它翻译过来。
 * 2. **认不出来的语言照实显示,不装作是纯文本。** 多出一个
 *    「brainfuck(未识别)」选项比显示"纯文本"诚实:后者会让人以为自己
 *    写的东西被系统改掉了。着色方面官方扩展会退回自动识别,不会报错。
 */
import type { Editor } from '@tiptap/core';

import { CODE_LANGUAGES, findLanguage, normalizeLanguage } from '../code-languages';

export function CodeLanguageSelect({ editor }: { editor: Editor }) {
  const raw = editor.getAttributes('codeBlock')['language'];
  const stored = typeof raw === 'string' ? raw : '';
  const known = stored === '' || findLanguage(stored) !== undefined;

  return (
    <label className="flex items-center gap-1.5">
      <span className="text-xs text-slate-500">语言</span>
      <select
        value={known ? normalizeLanguage(stored) : stored}
        aria-label="代码语言"
        onChange={(event) => {
          editor.chain().focus().updateAttributes('codeBlock', { language: event.target.value }).run();
        }}
        className="h-7 rounded-md border border-slate-300 bg-white px-1.5 text-xs text-slate-700 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
      >
        {CODE_LANGUAGES.map((language) => (
          <option key={language.id} value={language.id}>
            {language.label}
          </option>
        ))}
        {!known && <option value={stored}>{stored}(未识别)</option>}
      </select>
    </label>
  );
}
