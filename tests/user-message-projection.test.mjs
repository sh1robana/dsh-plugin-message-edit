import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

const SLOT = 'conversation.chat.node'

function fixture() {
  const effects = []
  const cleanups = []
  const faces = new Map()
  const states = new Map()
  const acquired = []
  const loaded = []
  const released = []
  const module = { exports: {} }
  const source = readFileSync(new URL('../src/client/UserMessageProjection.tsx', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024 },
  })
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: name => {
      assert.equal(name, 'react')
      return { ...React, useEffect: callback => effects.push(callback) }
    },
  })
  const slots = new SlotCore()
  const ctx = { slots, effect: factory => { const cleanup = factory(); cleanups.push(cleanup); return cleanup } }
  const faceFor = id => {
    if (!faces.has(id)) faces.set(id, {
      acquire: () => { acquired.push(id); return () => released.push(id) },
      load: () => loaded.push(id),
    })
    return faces.get(id)
  }
  const propsFor = (id, node, other = {}) => ({
    ...faceFor(id),
    node,
    sessionId: id,
    useMessageEdit: select => select(states.get(id) ?? { timeline: null }),
    ...other,
  })
  const declare = () => slots.register({
    name: 'root',
    children: { [SLOT]: { kind: 'keyed', scope: 'session' } },
  }, () => null)
  const install = () => module.exports.registerUserMessageProjection(ctx, faceFor)
  return { slots, effects, faces, states, acquired, loaded, released, propsFor, declare, install, cleanups }
}

test('公开用户消息插槽覆写保存的文本，复用官方渲染器并保留附件、复制及跳转属性', () => {
  const f = fixture()
  f.declare()
  const seen = []
  const Original = React.memo(props => {
    seen.push(props)
    return React.createElement('div', {}, props.node.data.content.filter(block => block.type === 'text').map(block => block.text).join('|'))
  })
  f.slots.register({ name: SLOT, key: 'user', locale: 'chat' }, Original)
  f.install()
  const wrapper = f.slots.entriesOfSlot(SLOT).find(entry => entry.options.key === 'user')
  assert.notEqual(wrapper.component, Original)
  assert.equal(wrapper.locale, 'chat')
  assert.equal(wrapper.inject('source'), f.faces.get('source'))
  const attachment = Object.freeze({ type: 'image', attachment: { attachmentId: 'image' } })
  const content = Object.freeze([
    Object.freeze({ type: 'text', text: '原始第一段' }),
    attachment,
    Object.freeze({ type: 'text', text: '原始第三段' }),
  ])
  const node = Object.freeze({ kind: 'user', data: Object.freeze({ seq: 3, content, time: 1 }) })
  f.states.set('source', { timeline: { messages: [
    { kind: 'user', eventSeq: 3, blockIndex: 0, text: '保存第一段' },
    { kind: 'user', eventSeq: 3, blockIndex: 2, text: '保存第三段' },
    { kind: 'assistant.response', eventSeq: 3, blockIndex: 0, text: '不能覆盖用户消息' },
    { kind: 'user', eventSeq: 5, blockIndex: 0, text: '另一条消息' },
  ] } })
  const openFile = () => {}
  const renderMessageImages = () => {}
  const t = value => value
  const element = wrapper.component(f.propsFor('source', node, { openFile, renderMessageImages, t }))
  assert.equal(element.type, Original)
  assert.equal(renderToStaticMarkup(element), '<div>保存第一段|保存第三段</div>')
  assert.equal(seen[0].openFile, openFile)
  assert.equal(seen[0].renderMessageImages, renderMessageImages)
  assert.equal(seen[0].t, t)
  assert.equal(seen[0].node.data.content[1], attachment)
  assert.equal(node.data.content[0].text, '原始第一段')
  assert.equal(node.data.content[2].text, '原始第三段')
})

test('同一消息序号在不同会话独立显示，用户消息和插话均使用投影，未修改消息保留身份', () => {
  const f = fixture()
  f.declare()
  const Original = () => null
  for (const key of ['user', 'steering']) f.slots.register({ name: SLOT, key }, Original)
  f.install()
  const node = { data: { seq: 3, content: [{ type: 'text', text: '原文' }] } }
  f.states.set('source', { timeline: { messages: [{ kind: 'user', eventSeq: 3, blockIndex: 0, text: '修改后' }] } })
  for (const wrapper of f.slots.entriesOfSlot(SLOT)) {
    assert.equal(wrapper.component(f.propsFor('source', node)).props.node.data.content[0].text, '修改后')
    assert.equal(wrapper.component(f.propsFor('other-session', node)).props.node, node)
  }
  const cleanup = f.effects[0]()
  assert.deepEqual(f.acquired, ['source'])
  assert.deepEqual(f.loaded, ['source'])
  cleanup()
  assert.deepEqual(f.released, ['source'])
})

test('完整用户内容替换旧图片并新增文件，官方渲染器收到最新附件及原有操作属性', () => {
  const f = fixture()
  f.declare()
  const seen = []
  const Original = props => {
    seen.push(props)
    return React.createElement('div', {}, props.node.data.content.map(block =>
      block.type === 'text' ? block.text : block.attachment.attachmentId).join('|'))
  }
  f.slots.register({ name: SLOT, key: 'user' }, Original)
  f.install()
  const wrapper = f.slots.entriesOfSlot(SLOT)[0]
  const oldImage = Object.freeze({ type: 'image', attachment: Object.freeze({ attachmentId: '旧图' }) })
  const originalContent = Object.freeze([Object.freeze({ type: 'text', text: '原始正文' }), oldImage])
  const node = Object.freeze({ kind: 'user', data: Object.freeze({ seq: 3, content: originalContent, time: 1 }), extra: '保留节点属性' })
  const image = Object.freeze({ type: 'image', attachment: Object.freeze({ attachmentId: '新图', name: '替换.png' }) })
  const file = Object.freeze({ type: 'file', attachment: Object.freeze({ attachmentId: '新文件', name: '说明.pdf' }) })
  const savedContent = Object.freeze([image, Object.freeze({ type: 'text', text: '完整保存正文' }), file])
  f.states.set('source', { timeline: { messages: [
    { kind: 'assistant.response', eventSeq: 3, content: [{ type: 'text', text: '忽略助手记录' }] },
    { kind: 'user', eventSeq: 4, content: [{ type: 'text', text: '忽略其他用户消息' }] },
    { kind: 'user', eventSeq: 3, blockIndex: 0, text: '旧位置的文本不能覆盖完整内容', content: savedContent },
  ] } })
  const openFile = () => {}
  const renderMessageImages = () => {}
  const copyMessage = () => {}
  const element = wrapper.component(f.propsFor('source', node, { openFile, renderMessageImages, copyMessage }))
  assert.equal(element.type, Original)
  assert.equal(renderToStaticMarkup(element), '<div>新图|完整保存正文|新文件</div>')
  assert.equal(seen[0].node.data.content, savedContent)
  assert.equal(seen[0].node.extra, node.extra)
  assert.equal(seen[0].node.data.time, node.data.time)
  assert.equal(seen[0].openFile, openFile)
  assert.equal(seen[0].renderMessageImages, renderMessageImages)
  assert.equal(seen[0].copyMessage, copyMessage)
  assert.equal(node.data.content, originalContent)
  assert.equal(node.data.content[1], oldImage)
  assert.equal(node.data.content[0].text, '原始正文')
})

test('删除附件和仅附件消息均按完整内容投影，空内容不会回退到旧正文', () => {
  const f = fixture()
  f.declare()
  const Original = () => null
  f.slots.register({ name: SLOT, key: 'user' }, Original)
  f.install()
  const wrapper = f.slots.entriesOfSlot(SLOT)[0]
  const image = Object.freeze({ type: 'image', attachment: Object.freeze({ attachmentId: '原图' }) })
  const file = Object.freeze({ type: 'file', attachment: Object.freeze({ attachmentId: '文件' }) })
  for (const [initial, saved] of [
    [[{ type: 'text', text: '原文' }, image], [{ type: 'text', text: '保留正文' }]],
    [[image], [file]],
    [[{ type: 'text', text: '原文' }, image], [image]],
    [[{ type: 'text', text: '原文' }, image], []],
  ]) {
    const content = Object.freeze(initial.map(block => Object.freeze(block)))
    const savedContent = Object.freeze(saved.map(block => Object.freeze(block)))
    const node = Object.freeze({ data: Object.freeze({ seq: 3, content }) })
    f.states.set('source', { timeline: { messages: [
      { kind: 'user', eventSeq: 3, blockIndex: 0, text: '不得回退的文本', content: savedContent },
    ] } })
    const projected = wrapper.component(f.propsFor('source', node)).props.node
    assert.notEqual(projected, node)
    assert.equal(projected.data.content, savedContent)
    assert.equal(node.data.content, content)
  }
})

test('完整内容结构未修改时保留节点身份，附件元数据改变时仍投影', () => {
  const f = fixture()
  f.declare()
  f.slots.register({ name: SLOT, key: 'user' }, () => null)
  f.install()
  const wrapper = f.slots.entriesOfSlot(SLOT)[0]
  const attachment = Object.freeze({ attachmentId: '同一文件', name: '原名.pdf', bytes: 12 })
  const file = Object.freeze({ type: 'file', attachment })
  const content = Object.freeze([Object.freeze({ type: 'text', text: '原文' }), file])
  const node = Object.freeze({ data: Object.freeze({ seq: 3, content }) })
  const savedContent = [
    { text: '原文', type: 'text' },
    { attachment: { bytes: 12, name: '原名.pdf', attachmentId: '同一文件' }, type: 'file' },
  ]
  f.states.set('source', { timeline: { messages: [{ kind: 'user', eventSeq: 3, content: savedContent }] } })
  assert.equal(wrapper.component(f.propsFor('source', node)).props.node, node)
  savedContent[1].attachment.name = '修改显示名.pdf'
  const projected = wrapper.component(f.propsFor('source', node)).props.node
  assert.notEqual(projected, node)
  assert.equal(projected.data.content[1].attachment.name, '修改显示名.pdf')
  assert.equal(node.data.content[1].attachment.name, '原名.pdf')
})

test('用户消息和插话的完整附件投影按会话隔离', () => {
  const f = fixture()
  f.declare()
  for (const key of ['user', 'steering']) f.slots.register({ name: SLOT, key }, () => null)
  f.install()
  const node = Object.freeze({ data: Object.freeze({ seq: 3, content: Object.freeze([
    Object.freeze({ type: 'image', attachment: Object.freeze({ attachmentId: '旧图' }) }),
  ]) }) })
  const firstContent = [{ type: 'file', attachment: { attachmentId: '会话一文件' } }]
  const secondContent = [{ type: 'image', attachment: { attachmentId: '会话二图片' } }]
  f.states.set('source', { timeline: { messages: [{ kind: 'user', eventSeq: 3, content: firstContent }] } })
  f.states.set('second', { timeline: { messages: [{ kind: 'user', eventSeq: 3, content: secondContent }] } })
  for (const wrapper of f.slots.entriesOfSlot(SLOT)) {
    assert.equal(wrapper.component(f.propsFor('source', node)).props.node.data.content, firstContent)
    assert.equal(wrapper.component(f.propsFor('second', node)).props.node.data.content, secondContent)
    assert.equal(wrapper.component(f.propsFor('unloaded', node)).props.node, node)
  }
})

test('官方聊天插槽延迟声明或重新注册时仍安装覆写，插件卸载恢复原组件', async () => {
  const f = fixture()
  f.install()
  const undeclare = f.declare()
  const Original = () => null
  const removeOriginal = f.slots.register({ name: SLOT, key: 'user', locale: 'chat' }, Original)
  await new Promise(resolve => setImmediate(resolve))
  const first = f.slots.entriesOfSlot(SLOT)[0]
  assert.notEqual(first.component, Original)
  assert.equal(f.slots.entries(SLOT).length, 2)
  removeOriginal()
  const Replacement = () => null
  f.slots.register({ name: SLOT, key: 'user', locale: 'chat' }, Replacement)
  await new Promise(resolve => setImmediate(resolve))
  const second = f.slots.entriesOfSlot(SLOT)[0]
  assert.notEqual(second.component, first.component)
  assert.equal(second.component(f.propsFor('source', { data: { seq: 1, content: [] } })).type, Replacement)
  f.cleanups[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.slots.entriesOfSlot(SLOT)[0].component, Replacement)
  assert.equal(f.slots.entries(SLOT).length, 1)
  undeclare()
})
