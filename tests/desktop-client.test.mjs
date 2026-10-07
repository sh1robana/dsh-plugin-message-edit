import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as stores from '@deepseek-ai/dsh-client-store'
import { Context, Service } from '@deepseek-ai/cordis'
import { renderToStaticMarkup } from 'react-dom/server'

function fixture(desktop, overrides = {}) {
  const requests = []
  const navigations = []
  const rows = []
  const listeners = new Set()
  const resetListeners = new Set()
  const events = { entries: [], hasMore: false, revision: 0 }
  const source = { getSnapshot: () => events, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } }
  let refreshCount = 0
  const list = stores.createSnapshotStore({ ids: ['source'], byId: { source: { id: 'source' } } }, { flush: 'sync' })
  const timeline = { sessionId: 'source', messages: [], retryableTurns: [], versions: [], undoStack: [], redoSessionIds: [] }
  let clientPlugin
  const fetchHost = async (path, init) => {
    requests.push({ path, ...init })
    if (init.method === 'POST') {
      if (overrides.postResponse) return overrides.postResponse(JSON.parse(init.body))
      const operation = JSON.parse(init.body)
      return Response.json(operation.action === 'save' ? { sessionId: 'source', queuedTurns: 0, saved: true } : { sessionId: 'child', queuedTurns: 1 })
    }
    return overrides.getResponse ? overrides.getResponse(path, init) : Response.json(timeline)
  }
  const globals = {
    AbortController, Response, URLSearchParams, TextEncoder, TextDecoder, btoa, atob, setTimeout, clearTimeout, console,
    document: { querySelector: () => ({}), createElement: () => { throw new Error('样式已存在，不应重复创建') } },
    fetch: desktop ? () => { throw new Error('桌面端应使用宿主传输') } : fetchHost,
    ...desktop ? { __DSH_TRANSPORT__: { fetch: fetchHost } } : {},
    ...overrides.globals,
    window: { __ModuleLoader__: { load: descriptor => {
      assert.equal(descriptor.id, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name)
      const table = { react: overrides.react ?? React, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-store': stores }
      const plugin = descriptor.factory(id => {
        assert.ok(table[id], `请求了桌面端模块表中不存在的运行时依赖：${id}`)
        return table[id]
      })
      clientPlugin = plugin
      const sessions = {
        list, binding: () => ({ eventSource: source }),
        refresh: async () => {
          refreshCount += 1
          list.update(value => { value.ids.push('child'); value.byId.child = { id: 'child' } })
        },
      }
      const ctx = {
        on: (name, callback) => {
          if (name === 'connection/reset') resetListeners.add(callback)
          return () => resetListeners.delete(callback)
        },
        get: name => overrides.services?.[name] ?? (name === 'sessions' ? sessions : name === 'conversation' ? overrides.conversation : undefined),
        uiConversation: { imageUrl: async (_sessionId, attachment) => `blob:${attachment.attachmentId}` },
        effect: factory => { const dispose = factory(); return async () => dispose?.() },
        uiWorkspace: { openSession: id => navigations.push(id) },
        slots: {
          inject: (_name, factory) => factory(),
          register: (entry, component) => { rows.push({ entry, component }); return () => {} },
        },
      }
      plugin.apply(ctx)
    } } },
  }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), globals)
  const face = rows[0].entry.inject('source')
  return { rows, face, requests, navigations, listeners, events, timeline, clientPlugin, globals,
    reset: () => { for (const listener of resetListeners) listener() }, refreshCount: () => refreshCount }
}

test('真实 Cordis 上下文中读取命令服务保留所需远程注入，不再出现 without inject', async () => {
  const { clientPlugin } = fixture(true)
  const root = new Context()
  root.provide('remote.commands', { candidates: async () => [{ name: 'file', label: '文件' }] })
  class Commands extends Service {
    static inject = ['remote.commands']
    constructor(ctx) { super(ctx, 'commandUi') }
    candidates() { return this.ctx['remote.commands'].candidates() }
  }
  root.plugin(Commands)
  for (const name of clientPlugin.inject) {
    if (name !== 'commandUi' && name !== 'remote.commands') root.provide(name, {})
  }
  let operation
  root.plugin({ inject: clientPlugin.inject, apply: ctx => {
    operation = Promise.resolve().then(() => ctx.get('commandUi').candidates())
  } })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(operation, '客户端依赖应全部就绪')
    assert.deepEqual(await operation, [{ name: 'file', label: '文件' }])
  } finally { await root.fiber.dispose() }
})

async function ready(face) {
  face.load()
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise(resolve => setImmediate(resolve))
    if (face.hooks.messageEdit.getSnapshot().status === 'ready') return
  }
  assert.fail(JSON.stringify(face.hooks.messageEdit.getSnapshot()))
}

test('编辑选项透传两种保存，读取目录和打开文件不触发版本导航', async () => {
  const options = { current: { provider: 'test', model: 'current' }, models: [], permissions: [] }
  const f = fixture(true, {
    getResponse: path => Response.json(path.includes('view=options') ? options : path.includes('view=references') ? [{ path: 'a.md', label: 'a.md', kind: 'file' }] : f.timeline),
    postResponse: operation => Response.json(operation.action === 'save' ? { sessionId: 'source', queuedTurns: 0, saved: true }
      : operation.action === 'edit' ? { sessionId: 'child', queuedTurns: 1 } : { opened: true }),
  })
  const release = f.face.acquire()
  try {
    await ready(f.face)
    assert.deepEqual(await f.face.composerTools.options(), options)
    assert.equal((await f.face.composerTools.references('a', new AbortController().signal))[0].path, 'a.md')
    await f.face.composerTools.openPath('D:/用户选择的文件.txt')
    await f.face.composerTools.openAttachment(3, 1)
    await f.face.composerTools.openUpload('receipt')
    assert.deepEqual(f.navigations, [])
    const settings = { provider: 'test', model: 'new', reasoningEffort: 'high', permissionPreset: 'workspace' }
    const message = { kind: 'user', eventSeq: 3, blockIndex: 0 }
    await f.face.edit(message, '保存内容', 'truncate', false, [], settings)
    await f.face.edit(message, '保存并发送', 'truncate', true, [], settings)
    const operations = f.requests.filter(request => request.method === 'POST').map(request => JSON.parse(request.body))
    assert.deepEqual(operations.slice(0, 3).map(operation => operation.action), ['open-reference', 'open-attachment', 'open-upload'])
    assert.deepEqual(operations[3].settings, settings)
    assert.deepEqual(operations[4].settings, settings)
    assert.deepEqual(f.navigations, ['child'])
  } finally { release() }
})

test('复用原生指令目录和执行通知，文件与会话候选合并而不访问主草稿', async () => {
  const calls = []
  const f = fixture(true, {
    getResponse: path => Response.json(path.includes('view=references') ? [{ path: 'a.md', label: 'a.md', kind: 'file' }] : f.timeline),
    services: {
      commandUi: {
        candidates: async (scope, request) => { calls.push(['catalog', scope.sessionId, request.query]); return [{ name: 'export', label: '下载日志' }] },
        execute: async (scope, line) => { calls.push(['command', scope.sessionId, line]); return line === '/bad' ? { kind: 'error', text: '指令失败' } : { kind: 'success' } },
      },
      remote: { sessionReferenceResolver: { candidates: async () => ({ ok: true, value: [{ sessionId: 'other', label: '另一会话', mention: '@[另一会话](dsh-session:Im90aGVyIg)' }] }) } },
      conversation: { get input() { throw new Error('编辑框不能访问主草稿') } },
    },
  })
  const tools = f.face.composerTools
  assert.equal((await tools.commands('', new AbortController().signal))[0].name, 'export')
  await tools.command('/export')
  await assert.rejects(() => tools.command('/bad'), /指令失败/)
  const references = await tools.references('', new AbortController().signal)
  assert.deepEqual(Array.from(references, item => item.kind), ['file', 'session'])
  assert.deepEqual(calls, [['catalog', 'source', ''], ['command', 'source', '/export'], ['command', 'source', '/bad']])
  assert.deepEqual(f.navigations, [])
})

for (const desktop of [false, true]) {
  test(`${desktop ? '桌面端' : 'Web'}：加载前端模块、读取历史、重生成并使用新版导航`, async () => {
    const f = fixture(desktop)
    const release = f.face.acquire()
    try {
      await ready(f.face)
      assert.equal(f.requests[0].path, 'api/message-edit?sessionId=source')
      assert.equal(await f.face.reroll(), true)
      assert.equal(f.requests[1].path, 'api/message-edit')
      assert.equal(JSON.parse(f.requests[1].body).action, 'reroll')
      assert.equal(f.refreshCount(), 1)
      assert.deepEqual(f.navigations, ['child'])
      assert.equal(f.rows[0].entry.inject('source'), f.rows[1].entry.inject('source'))
    } finally {
      release()
    }
  })
}

test('闭合回合发布后刷新历史，卸载后解除事件订阅', async () => {
  const f = fixture(true)
  const release = f.face.acquire()
  await ready(f.face)
  f.events.entries.push({ type: 'event', event: { type: 'turn/end', seq: 12, data: { turn: 1 } } })
  for (const listener of f.listeners) listener()
  await new Promise(resolve => setTimeout(resolve, 330))
  assert.equal(f.requests.length, 2)
  release()
  assert.equal(f.listeners.size, 0)
})

test('同一会话的标题栏、时间线及分批用户消息挂载共享一次加载，就绪后不重复请求', async () => {
  const f = fixture(true)
  const release = f.face.acquire()
  try {
    f.face.load()
    f.face.load()
    await ready(f.face)
    for (let index = 0; index < 50; index++) {
      const face = f.rows[index % 2].entry.inject('source')
      const unmount = face.acquire()
      face.load()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(face.hooks.messageEdit.getSnapshot().status, 'ready')
      unmount()
    }
    assert.equal(f.requests.filter(request => request.method === 'GET').length, 1)
  } finally { release() }
})

test('后台刷新期间保持消息可操作，保存等待保存后的刷新而不复用旧请求', async () => {
  let resolveBackground
  let resolveSaved
  let reads = 0
  const f = fixture(true, { getResponse: () => {
    reads++
    if (reads === 2) return new Promise(resolve => { resolveBackground = resolve })
    if (reads === 3) return new Promise(resolve => { resolveSaved = resolve })
    return Response.json(f.timeline)
  } })
  const release = f.face.acquire()
  try {
    await ready(f.face)
    const original = { key: '3:0', turn: 1, eventSeq: 3, blockIndex: 0, kind: 'user', text: '保存前', time: 1 }
    f.timeline.messages.push(original)
    const oldSnapshot = Response.json(f.timeline)
    f.reset()
    assert.equal(reads, 2)
    assert.equal(f.face.hooks.messageEdit.getSnapshot().status, 'ready')
    f.face.load()
    let completed = false
    const saved = f.face.edit(original, '保存后', 'truncate', false).then(value => { completed = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1)
    assert.equal(f.face.hooks.messageEdit.getSnapshot().pending, 'edit')
    resolveBackground(oldSnapshot)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads, 3)
    assert.equal(completed, false)
    assert.equal(f.face.hooks.messageEdit.getSnapshot().pending, 'edit')
    resolveSaved(Response.json({ ...f.timeline, messages: [{ ...original, text: '保存后' }] }))
    assert.equal(await saved, true)
    assert.equal(f.face.hooks.messageEdit.getSnapshot().timeline.messages[0].text, '保存后')
    assert.equal(f.face.hooks.messageEdit.getSnapshot().pending, null)
  } finally { release() }
})

test('首次读取期间离开并立即返回会话，旧响应不提交且新请求正常恢复按钮状态', async () => {
  const responses = []
  const f = fixture(true, { getResponse: () => new Promise(resolve => responses.push(resolve)) })
  let release = f.face.acquire()
  try {
    f.face.load()
    release()
    release = f.face.acquire()
    f.face.load()
    responses[0](Response.json({ ...f.timeline, messages: [{ key: '3:0', turn: 1, eventSeq: 3, blockIndex: 0,
      kind: 'user', text: '过期读取', time: 1 }] }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(responses.length, 2)
    assert.equal(f.face.hooks.messageEdit.getSnapshot().status, 'loading')
    assert.equal(f.face.hooks.messageEdit.getSnapshot().timeline, null)
    responses[1](Response.json({ ...f.timeline, messages: [{ key: '3:0', turn: 1, eventSeq: 3, blockIndex: 0,
      kind: 'user', text: '重新打开后的内容', time: 1 }] }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.face.hooks.messageEdit.getSnapshot().status, 'ready')
    assert.equal(f.face.hooks.messageEdit.getSnapshot().timeline.messages[0].text, '重新打开后的内容')
    assert.equal(f.requests.length, 2)
  } finally { release() }
})

test('Timeline 和标题栏组件可以使用新版插槽属性渲染', async () => {
  const f = fixture(true)
  const release = f.face.acquire()
  try {
    await ready(f.face)
    const props = { ...f.face, useMessageEdit: selector => selector(f.face.hooks.messageEdit.getSnapshot()) }
    for (const { component } of f.rows) {
      const html = renderToStaticMarkup(React.createElement(component, props))
      assert.ok(html.includes('button'))
    }
  } finally {
    release()
  }
})

test('客户端只保存刷新当前会话不导航，保存并发送才打开新会话', async () => {
  const f = fixture(true)
  const release = f.face.acquire()
  try {
    await ready(f.face)
    const message = { kind: 'user', eventSeq: 3, blockIndex: 0 }
    assert.equal(await f.face.edit(message, '保存草稿', 'truncate', false), true)
    assert.deepEqual(f.navigations, [])
    assert.equal(f.refreshCount(), 0)
    assert.equal(f.requests.filter(request => request.method === 'GET').length, 2)
    assert.equal(await f.face.edit(message, '保存并发送', 'truncate', true), true)
    const operations = f.requests.filter(request => request.method === 'POST').map(request => JSON.parse(request.body))
    assert.equal(operations[0].action, 'save')
    assert.equal(operations[0].regenerate, undefined)
    assert.equal(operations[1].action, 'edit')
    assert.equal(operations[1].regenerate, true)
    assert.deepEqual(f.navigations, ['child'])
    assert.equal(f.refreshCount(), 1)
  } finally {
    release()
  }
})

test('旧宿主拒绝只保存时保留错误，不降级为发送或切换窗口', async () => {
  const f = fixture(true, { postResponse: () => Response.json({ error: '宿主不支持 save，请重启更新后的 DSH' }, { status: 400 }) })
  const release = f.face.acquire()
  try {
    await ready(f.face)
    assert.equal(await f.face.edit({ kind: 'user', eventSeq: 3, blockIndex: 0 }, '草稿', 'truncate', false), false)
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1)
    assert.deepEqual(f.navigations, [])
    assert.equal(f.refreshCount(), 0)
    assert.match(f.face.hooks.messageEdit.getSnapshot().error, /宿主不支持 save/)
  } finally {
    release()
  }
})

test('只保存响应若仍返回新会话则拒绝导航，提示重启插件', async () => {
  const f = fixture(true, { postResponse: () => Response.json({ sessionId: 'child', queuedTurns: 1 }) })
  const release = f.face.acquire()
  try {
    await ready(f.face)
    assert.equal(await f.face.edit({ kind: 'user', eventSeq: 3, blockIndex: 0 }, '草稿', 'truncate', false), false)
    assert.deepEqual(f.navigations, [])
    assert.match(f.face.hooks.messageEdit.getSnapshot().error, /宿主未确认在当前会话保存/)
  } finally {
    release()
  }
})

test('其他窗口发布保存事件时刷新消息投影，不触发导航', async () => {
  const f = fixture(true)
  const release = f.face.acquire()
  try {
    await ready(f.face)
    f.events.entries.push({ type: 'event', event: { type: 'user/message', seq: 22, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: { source: { kind: 'user', messageEdit: { originalEventSeq: 3 } } } } })
    for (const listener of f.listeners) listener()
    await new Promise(resolve => setTimeout(resolve, 330))
    assert.equal(f.requests.length, 2)
    assert.deepEqual(f.navigations, [])
  } finally {
    release()
  }
})

test('消息按钮按新版回合标识定位重复文本，点击编辑和重试对应回合，卸载后清理', async () => {
  class Element {
    children = []
    listeners = new Map()
    dataset = {}
    textContent = ''
    nodeType = 1
    get childNodes() { return this.children }
    set innerHTML(value) { this.textContent = value.replace(/<[^>]*>/g, '') }
    get innerHTML() { return this.textContent }
    constructor(tag) { this.tagName = tag }
    append(...elements) {
      for (const element of elements) { element.parent = this; this.children.push(element) }
    }
    appendChild(element) { this.append(element) }
    prepend(...elements) {
      for (const element of elements) element.parent = this
      this.children.unshift(...elements)
    }
    replaceChildren(...elements) {
      for (const child of this.children) child.parent = undefined
      this.children = []
      this.append(...elements)
    }
    setAttribute(name, value) { this[name] = value }
    getAttribute(name) { return this[name] }
    contains(node) { return node === this || this.children.some(child => child.contains?.(node)) }
    addEventListener(name, listener) { this.listeners.set(name, listener) }
    removeEventListener(name) { this.listeners.delete(name) }
    querySelectorAll() { return this.children.filter(child => child.tagName === 'button') }
    closest() { return this.flow }
    insertAdjacentElement(_position, element) {
      element.parent = this.parent
      this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, element)
    }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1) }
    focus() {}
    setSelectionRange() {}
    click() { this.listeners.get('click')?.({ target: this }) }
  }
  const body = new Element('body')
  const actionRows = []
  for (const [kind, turn] of [['user', 1], ['turn-tail', 1], ['user', 2], ['turn-tail', 2], ['assistant', 2]]) {
    const row = new Element('div')
    row.flow = { dataset: { chatFlowKind: kind, chatTurn: String(turn) } }
    row.append(new Element('button'))
    body.append(row)
    actionRows.push(row)
  }
  const effects = []
  const hookValues = []
  let hookCursor = 0
  const f = fixture(true, {
    react: { ...React, useEffect: callback => { effects.push(callback) },
      useLayoutEffect: (callback, dependencies) => {
        const index = hookCursor++
        const previous = hookValues[index]
        if (previous === undefined || dependencies.some((value, offset) => value !== previous[offset])) effects.push(callback)
        hookValues[index] = dependencies
      },
      useRef: current => hookValues[hookCursor++] ??= { current } },
    globals: {
      document: {
        body, querySelector: () => ({}), querySelectorAll: () => actionRows,
        createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag),
        createRange: () => {
          let node
          return { selectNodeContents: value => { node = value }, cloneContents: () => node }
        },
        getSelection: () => null, addEventListener() {}, removeEventListener() {},
      },
      MutationObserver: class { observe() {} disconnect() {} },
    },
  })
  const release = f.face.acquire()
  let unmount
  try {
    await ready(f.face)
    const messages = [
      { turn: 1, eventSeq: 3, kind: 'user', text: '重复文本' },
      { turn: 1, eventSeq: 5, kind: 'assistant.response', text: '重复文本' },
      { turn: 2, eventSeq: 9, kind: 'user', text: '重复文本' },
      { turn: 2, eventSeq: 11, kind: 'assistant.response', text: '重复文本' },
    ].map(block => ({ ...block, blockIndex: 0 }))
    const edited = []
    const retried = []
    const header = f.rows.find(row => row.entry.name === 'conversation.session.header.actions').component({
      ...f.face,
      useMessageEdit: selector => selector({ ...f.face.hooks.messageEdit.getSnapshot(), timeline: { ...f.timeline, messages } }),
      edit: async (block, text, _cascade, regenerate) => { edited.push({ block, text, regenerate }); return true },
      retry: async turn => { retried.push(turn); return true },
    })
    const inline = header.props.children[0]
    const renderInline = props => { hookCursor = 0; inline.type(props) }
    renderInline(inline.props)
    unmount = effects.at(-2)()
    const descendants = node => [node, ...node.children.flatMap(descendants)]
    const editorInput = panel => descendants(panel).find(child => child.tagName === 'textarea' || child.role === 'textbox')
    const setEditorText = (panel, text) => {
      const input = editorInput(panel)
      if (input.tagName === 'textarea') input.value = text
      else input.textContent = text
      input.listeners.get('input')?.({ target: input })
    }
    assert.deepEqual(actionRows.map(row => row.children.length), [3, 3, 3, 3, 1])
    for (const [index, row] of actionRows.slice(0, 4).entries()) {
      row.children.find(button => button.title === '编辑消息').click()
      const overlay = body.children.at(-1)
      const panel = overlay.children[0]
      const footer = panel.children.at(-1)
      assert.deepEqual(footer.children.filter(button => button.tagName === 'button').map(button => button.textContent),
        messages[index].kind === 'user' ? ['保存', '保存并发送', '取消'] : ['保存', '取消'])
      setEditorText(panel, `修改 ${index}`)
      footer.children.find(button => button.textContent === '保存').click()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(edited[index].block.eventSeq, messages[index].eventSeq)
      assert.equal(edited[index].text, `修改 ${index}`)
      assert.equal(edited[index].regenerate, messages[index].kind !== 'user')
      row.children.find(button => button.title === '重试此回合').click()
    }
    assert.deepEqual(retried, [1, 1, 2, 2])
    const openUserEditor = () => {
      actionRows[0].children.find(button => button.title === '编辑消息').click()
      return body.children.at(-1).children[0]
    }
    const panel = openUserEditor()
    setEditorText(panel, '未保存的草稿')
    const firstButton = actionRows[0].children.find(button => button.title === '编辑消息')
    const updatedMessages = messages.map((message, index) => index === 0 ? { ...message, text: '刷新后的最新正文' } : message)
    renderInline({ ...inline.props, messages: updatedMessages, disabled: true })
    effects.at(-1)()
    assert.equal(actionRows[0].children.find(button => button.title === '编辑消息'), firstButton)
    assert.equal(firstButton.disabled, true)
    assert.equal(body.children.at(-1).children[0], panel)
    assert.equal(editorInput(panel).textContent, '未保存的草稿')
    renderInline({ ...inline.props, messages: updatedMessages, disabled: false })
    effects.at(-1)()
    assert.equal(firstButton.disabled, false)
    panel.children.at(-1).children.find(button => button.textContent === '取消').click()
    assert.equal(body.children.length, 7)
    const confirmation = body.children.at(-1).children[0]
    assert.equal(confirmation['aria-label'], '是否确认取消编辑')
    assert.deepEqual(confirmation.children[1].children.map(button => button.textContent), ['是', '否'])
    confirmation.children[1].children[1].click()
    assert.equal(body.children.length, 6)
    assert.equal(editorInput(panel).textContent, '未保存的草稿')
    panel.children.at(-1).children.find(button => button.textContent === '取消').click()
    body.children.at(-1).children[0].children[1].children[0].click()
    assert.equal(body.children.length, 5)
    assert.equal(edited.length, 4)
    const sendPanel = openUserEditor()
    assert.equal(editorInput(sendPanel).textContent, '刷新后的最新正文')
    setEditorText(sendPanel, '修改并发送')
    const send = sendPanel.children.at(-1).children.find(button => button.textContent === '保存并发送')
    send.click()
    send.click()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(edited.length, 5)
    assert.equal(edited.at(-1).regenerate, true)
    assert.equal(edited.at(-1).text, '修改并发送')
    openUserEditor().children.at(-1).children.find(button => button.textContent === '取消').click()
    unmount()
    unmount = undefined
    assert.deepEqual(actionRows.map(row => row.children.length), [1, 1, 1, 1, 1])
    assert.equal(body.children.length, 5)
  } finally {
    unmount?.()
    release()
  }
})

test('客户端读取附件及完整内容，两种保存传递附件列表且未传附件保持兼容', async () => {
  const f = fixture(true)
  const release = f.face.acquire()
  try {
    const image = { type: 'image', attachment: { attachmentId: 'old-image', mediaType: 'image/png', bytes: 12, width: 1, height: 1, name: '原图.png' } }
    const message = { key: '3:0', turn: 1, eventSeq: 3, blockIndex: 0, kind: 'user', text: '原文', time: 1,
      content: [{ type: 'text', text: '原文' }, image], attachments: [{ blockIndex: 1, content: image }] }
    f.timeline.messages.push(message)
    await ready(f.face)
    const decoded = f.face.hooks.messageEdit.getSnapshot().timeline.messages[0]
    assert.equal(decoded.attachments[0].content.attachment.name, '原图.png')
    assert.equal(decoded.content[1].type, 'image')
    assert.equal(await f.face.edit(decoded, '移除原图', 'truncate', false, []), true)
    const attachments = [{ type: 'retained', blockIndex: 1 }, { type: 'file', receiptId: 'new-file-receipt' }]
    assert.equal(await f.face.edit(decoded, '换附件并发送', 'truncate', true, attachments), true)
    assert.equal(await f.face.edit(decoded, '旧版文本修改', 'truncate', false), true)
    const operations = f.requests.filter(request => request.method === 'POST').map(request => JSON.parse(request.body))
    assert.deepEqual(operations[0].attachments, [])
    assert.deepEqual(operations[1].attachments, attachments)
    assert.equal(Object.hasOwn(operations[2], 'attachments'), false)
    assert.deepEqual(f.navigations, ['child'])
  } finally {
    release()
  }
})

test('用户及助手无修改保存不刷新、不导航，错误的无修改确认被拒绝', async () => {
  const f = fixture(true, { postResponse: operation => Response.json({ sessionId: operation.sessionId, queuedTurns: 0,
    unchanged: true, ...operation.action === 'save' ? { saved: true } : {} }) });
  const release = f.face.acquire();
  try {
    await ready(f.face);
    const gets = f.requests.filter(r => r.method === 'GET').length;
    for (const kind of ['user', 'assistant.response']) {
      assert.equal(await f.face.edit({ kind, eventSeq: 3, blockIndex: 0 }, '原文', 'truncate', kind !== 'user'), true);
    }
    assert.equal(f.requests.filter(r => r.method === 'GET').length, gets);
    assert.deepEqual(f.navigations, []);
    assert.equal(f.refreshCount(), 0);
    assert.equal(f.face.hooks.messageEdit.getSnapshot().pending, null);
  } finally { release(); }
  const invalid = fixture(true, { postResponse: () => Response.json({ sessionId: 'child', queuedTurns: 1, unchanged: true }) });
  const done = invalid.face.acquire();
  try {
    await ready(invalid.face);
    assert.equal(await invalid.face.edit({ kind: 'assistant.response', eventSeq: 3, blockIndex: 0 }, '原文', 'truncate'), false);
    assert.deepEqual(invalid.navigations, []);
  } finally { done(); }
});

test('同版本旧构建也被识别并阻止编辑，客户端诊断能核对实际宿主', async () => {
  const old = fixture(true, { getResponse: () => Response.json({ build: { version: old.clientPlugin.MESSAGE_EDIT_BUILD_INFO.version, buildId: '旧构建' } }) });
  old.face.load();
  for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(old.face.hooks.messageEdit.getSnapshot().status, 'error');
  assert.match(old.face.hooks.messageEdit.getSnapshot().error, /前后端版本不一致/);
  assert.equal(await old.face.edit({ kind: 'user', eventSeq: 3, blockIndex: 0 }, '草稿', 'truncate', false), false);
  assert.equal(old.requests.some(r => r.method === 'POST'), false);
  const compatible = fixture(true, { getResponse: () => Response.json({ build: compatible.clientPlugin.MESSAGE_EDIT_BUILD_INFO, recent: [] }) });
  const value = await compatible.globals.__DSH_MESSAGE_EDIT__.diagnostics();
  assert.equal(value.matched, true);
  assert.equal(value.client.buildId, value.host.build.buildId);
});
