import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function fixture(bridge) {
  const module = { exports: {} }
  const source = readFileSync(new URL('../src/client/fileReferences.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024 },
  })
  runInNewContext(outputText, { module, exports: module.exports, URL, TextEncoder, TextDecoder, btoa, atob, __DSH_HOST_PATHS__: bridge })
  return module.exports
}

const helpers = fixture()
const clipboard = values => ({ getData: type => values[type] ?? '' })
const ordinary = value => JSON.parse(JSON.stringify(value))

test('文件引用引用空格且拒绝无法安全表示的路径', () => {
  assert.equal(helpers.formatFileReference('D:\\DeepSeek Harness\\附件.txt'), '@"D:/DeepSeek Harness/附件.txt"')
  assert.equal(helpers.formatFileReference('目录/附件.txt'), '@目录/附件.txt')
  assert.throws(() => helpers.formatFileReference('文件\n第二行'))
  assert.throws(() => helpers.formatFileReference('文件"名'))
  assert.throws(() => helpers.formatFileReference(''))
})

test('文件 chip 保留原始 token 和准确文本位置，不吞掉相邻文字', () => {
  const text = '查看 @目录/附件.txt 和 @"D:/带 空格/图片.png"\n@目录/ 后继续'
  const refs = helpers.parseFileReferences(text)
  assert.equal(refs.length, 3)
  for (const ref of refs) assert.equal(text.slice(ref.start, ref.end), ref.token)
  assert.deepEqual(ordinary(refs.map(({ path, label }) => ({ path, label }))), [
    { path: '目录/附件.txt', label: '附件.txt' },
    { path: 'D:/带 空格/图片.png', label: '图片.png' },
    { path: '目录/', label: '目录/' },
  ])
})

test('邮件、未闭合引号及会话 Markdown 引用不变成文件 chip', () => {
  assert.deepEqual(ordinary(helpers.parseFileReferences('a@b.com @"未完成路径 @[对话](dsh-session:ImFiYyI) @dsh-session:ImFiYyI')), [])
})

test('剪贴板 URI 支持 Windows、UNC 和编码空格并按路径去重', () => {
  const data = clipboard({
    'text/uri-list': '# 剪贴板文件\r\nfile:///D:/DeepSeek%20Harness/test.txt\r\nfile://server/share/%E6%96%87%E4%BB%B6.txt\r\n',
    'text/plain': '"D:\\DeepSeek Harness\\test.txt"',
  })
  assert.deepEqual(ordinary(helpers.pastedFilePaths(data)), ['D:/DeepSeek Harness/test.txt', '//server/share/文件.txt'])
})

test('普通粘贴文本、网页地址和夹有路径的说明不会被路径解析接管', () => {
  for (const content of ['https://example.com/a', '这里是一段文字\nD:/test.txt', '# 这是说明\nD:/test.txt', 'file:///D:/test%ZZ.txt', '相对路径.txt', '/goal', '/goal 明天整理资料', '/plan off']) {
    assert.deepEqual(ordinary(helpers.pastedFilePaths(clipboard({ 'text/plain': content }))), [])
  }
})

test('会话引用与官方 UTF-8 JSON base64url 编码一致，并保留显示名转义', () => {
  const sessionId = '会话-甲/乙'
  const label = '名称]与\\字符'
  const token = helpers.formatSessionReference(sessionId, label)
  const encoded = Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
  assert.equal(token, `@[名称\\]与\\\\字符](dsh-session:${encoded})`)
  const text = `前文 ${token} 后文`
  assert.deepEqual(ordinary(helpers.parseSessionReferences(text)), [{
    start: 3, end: 3 + token.length, sessionId, token, label,
  }])
  assert.deepEqual(ordinary(helpers.parseFileReferences(text)), [])
})

test('裸会话 URI 可以导航，非canonical JSON及损坏 URI不生成chip', () => {
  const valid = `dsh-session:${Buffer.from(JSON.stringify('abc')).toString('base64url')}`
  assert.equal(helpers.parseSessionReferences(valid)[0].sessionId, 'abc')
  const invalid = `dsh-session:${Buffer.from(' "abc" ').toString('base64url')}`
  assert.deepEqual(ordinary(helpers.parseSessionReferences(`${invalid} @[坏](dsh-session:abc!) dsh-session:e30`)), [])
})

test('宿主文件路径仅由 DSH 桥读取，合成 File 与失效桥安全返回空值', () => {
  const file = { name: 'test.txt', path: '不使用未授权的旧属性' }
  assert.equal(helpers.filePathFor(file), undefined)
  assert.equal(fixture({ pathFor: selected => selected === file ? 'D:\\test.txt' : '' }).filePathFor(file), 'D:\\test.txt')
  assert.equal(fixture({ pathFor: () => '' }).filePathFor(file), undefined)
  assert.equal(fixture({ pathFor: () => { throw new Error('失效') } }).filePathFor(file), undefined)
})
