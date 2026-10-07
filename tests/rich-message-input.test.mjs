import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const module = { exports: {} }
const source = readFileSync(new URL('../src/client/RichMessageInput.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024 } })
runInNewContext(outputText, {
  module, exports: module.exports,
  require: name => name.endsWith('.module.css') ? { default: {} } : {},
})
const readText = module.exports.messageInputText
const text = value => ({ nodeType: 3, textContent: value })
const element = (tagName, childNodes = [], dataset = {}) => ({ nodeType: 1, tagName, childNodes, dataset, textContent: '' })

test('富文本正文保留段落、空行及普通空格，不将显示图标保存为正文', () => {
  const input = element('DIV', [
    text('第一行'), element('DIV', [text('第二行')]),
    element('DIV', [element('BR')]), element('DIV', [text('第三\u00a0行')]),
  ])
  assert.equal(readText(input), '第一行\n第二行\n\n第三 行')
})

test('文件与会话 chip 持久化 canonical 引用，保留相邻正文', () => {
  const file = '@"D:/带 空格/文件.pdf"'
  const session = '@[会话](dsh-session:ImFiYyI)'
  const input = element('DIV', [text('请看 '), element('SPAN', [text('▤ 文件.pdf')], { fileToken: file }),
    text(' 和 '), element('SPAN', [text('@ 会话')], { fileToken: session }), text(' 后继续。')])
  assert.equal(readText(input), `请看 ${file} 和 ${session} 后继续。`)
})

test('复制选区片段同样展开引用并保留换行', () => {
  const fragment = { nodeType: 11, childNodes: [text('资料 '), element('SPAN', [], { fileToken: '@readme.md' }), element('BR'), text('结束')] }
  assert.equal(readText(fragment), '资料 @readme.md\n结束')
})

function keyboardFixture(initial = '') {
  const handlers = new Map();
  const input = { dataset: {}, childNodes: [], nodeType: 1, tagName: 'DIV',
    setAttribute() {}, append() {}, remove() {}, contains: node => node === input,
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: name => handlers.delete(name) };
  const document = { createElement: () => input, getSelection: () => null,
    createRange: () => ({ selectNodeContents() {}, cloneContents: () => ({ nodeType: 11, childNodes: [] }) }) };
  const target = { exports: {} };
  runInNewContext(outputText, { module: target, exports: target.exports, document,
    require: name => name.endsWith('.css') ? { default: {} } : {
      parseFileReferences: () => [], parseSessionReferences: () => [], pastedFilePaths: () => [] } });
  const calls = { save: 0, send: 0, suggestion: 0, change: 0 };
  const mounted = target.exports.mountRichMessageInput({ append() {} }, initial, {
    onSend: () => calls.send++, onSave: () => calls.save++,
    onKeydown: () => { calls.suggestion++; return false; }, onChange: () => calls.change++,
  });
  const emit = (name, extra = {}) => {
    const event = { target: input, preventDefault() { this.defaultPrevented = true; }, ...extra };
    handlers.get(name)?.(event);
    return event;
  };
  return { calls, mounted, emit, handlers, input };
}

test('只打开、聚焦和使用保存快捷键时保留原始不换行空格及尾部空行', () => {
  const original = '原文\u00a0空格\n\n';
  const f = keyboardFixture(original);
  f.input.childNodes = [text(original)];
  f.emit('keyup');
  f.emit('keydown', { key: 's', ctrlKey: true });
  assert.equal(f.mounted.text(), original);
  f.emit('input');
  assert.equal(f.mounted.text(), '原文 空格\n\n');
  f.mounted.dispose();
});

test('拼音候选确认的 229 回车与组合中快捷键均不触发保存、发送或引用选择', () => {
  const f = keyboardFixture();
  f.emit('keydown', { key: 'Enter', isComposing: false, keyCode: 229 });
  f.emit('keydown', { key: 'Enter', isComposing: true });
  f.emit('compositionstart');
  f.emit('keydown', { key: 'Enter', isComposing: false });
  f.emit('keydown', { key: 's', ctrlKey: true });
  f.emit('input');
  assert.deepEqual(f.calls, { save: 0, send: 0, suggestion: 0, change: 0 });
  f.emit('compositionend');
  assert.equal(f.calls.change, 1);
  assert.equal(f.emit('keydown', { key: 'Enter' }).defaultPrevented, true);
  f.emit('keydown', { key: 's', ctrlKey: true });
  f.emit('keydown', { key: 'Enter', shiftKey: true });
  assert.equal(f.calls.send, 1);
  assert.equal(f.calls.save, 1);
  f.mounted.setDisabled(true);
  f.emit('keydown', { key: 'Enter' });
  assert.equal(f.calls.send, 1);
  f.mounted.dispose();
  assert.equal(f.handlers.size, 0);
});
