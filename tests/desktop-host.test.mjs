import test from 'node:test'
import assert from 'node:assert/strict'
import { win32 as windowsPath } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { apply, MESSAGE_EDIT_PATH, MESSAGE_EDIT_BUILD_INFO } from '../index.mjs'

function fixture(userContents = []) {
  const core = new Context()
  new Projections(core)
  new Sessions(core)
  const detachers = new Map()
  const create = (id, options) => {
    const session = core.sessions.prepare(id, options)
    detachers.set(id, core.sessions.enter(session))
    core.sessions.announce(session)
    return session
  }
  const source = create('source', { meta: { agentPreset: 'roleplay' } })
  const user = (text, content) => ({ id: crypto.randomUUID(), role: 'user', content: structuredClone(content ?? [{ type: 'text', text }]), source: { kind: 'user' } })
  for (const turn of [1, 2]) {
    const input = user(`用户输入 ${turn}`, userContents[turn - 1])
    source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] })
    source.append('turn/start', { turn })
    source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    source.append('user/message', input, { surfaceOp: 'append' })
    source.append('step/start', { turn, step: 1 })
    source.append('request/header', { reason: turn === 1 ? 'initial' : 'series', header: { config: { provider: 'test', model: 'test-model' } } })
    source.append('assistant/message', { turn, step: 1, stream: [], message: {
      id: crypto.randomUUID(), role: 'assistant',
      content: [{ type: 'reasoning', text: `思考 ${turn}` }, { type: 'text', text: `回复 ${turn}` }],
      source: { kind: 'model', provider: 'test', model: 'test-model' },
    } }, { surfaceOp: 'append' })
    source.append('step/end', { turn, step: 1 })
    source.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const logs = new Map()
  const agents = new Map()
  const children = []
  const mounted = []
  const workspaceActions = []
  const followups = []
  const services = new Map()
  const getLog = id => {
    const live = core.sessions.get(id)
    if (live !== undefined) return { session: live.header, inheritedEventCount: live.inheritedEventCount, events: live.snapshotEvents() }
    const stored = logs.get(id)
    if (stored === undefined) throw new Error('会话不存在')
    return stored
  }
  const getRecords = () => [...new Set([...core.sessions.list().map(s => s.id), ...logs.keys()])]
    .map(id => ({ header: getLog(id).session, live: core.sessions.get(id) !== undefined, persisted: logs.has(id) }))
  const originalFlush = core.sessions.flush.bind(core.sessions)
  core.sessions.flush = async session => {
    await originalFlush(session)
    logs.set(session.id, structuredClone({ session: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }))
  }
  const wrap = (session, options = { provider: 'test', model: 'test-model' }) => ({
    id: session.id, session, options,
    runMaintenance: job => job(), followup: input => {
      followups.push({ sessionId: session.id, input })
      children.find(c => c.agent.session === session)?.queued.push(input)
    },
  })
  agents.set(source.id, wrap(source))
  let route
  const ctx = {
    sessions: core.sessions,
    agents: {
      get: id => agents.get(id),
      create: async options => {
        const session = create(options.sessionId, options)
        await options.setup?.({})
        // 使用 DSH 的真实存储校验器验证插件事件在重启后仍可读取。
        validateStoredEvents(session.header, structuredClone(session.snapshotEvents()))
        const child = { agent: wrap(session, options.agentOptions), queued: [], dispose: async () => { agents.delete(session.id); detachers.get(session.id)() } }
        agents.set(session.id, child.agent)
        children.push(child)
        return child
      },
      resume: async options => {
        const stored = getLog(options.resumeSessionId)
        const session = create(options.resumeSessionId, {
          seed: stored.events, meta: stored.session, inheritedEventCount: stored.inheritedEventCount,
        })
        await options.setup?.({})
        const agent = wrap(session, options.agentOptions)
        agents.set(session.id, agent)
        return { agent, dispose: async () => { agents.delete(session.id); detachers.get(session.id)() } }
      },
    },
    sessionQuery: {
      readSession: async id => getLog(id),
      traceSession: async id => {
        const records = getRecords()
        const target = records.find(r => r.header.id === id)
        const descendants = parent => records.filter(r => r.header.parentSession === parent)
          .map(session => ({ session, descendants: descendants(session.header.id) }))
        const ancestors = []
        let current = target
        while (current.header.parentSession !== undefined) {
          current = records.find(r => r.header.id === current.header.parentSession)
          ancestors.push(current)
        }
        return { target, ancestors, descendants: descendants(id), complete: true, root: current }
      },
    },
    workspaceRegistry: { list: () => [{ sessionIds: [source.id], attachSession: async id => { workspaceActions.push(['attach', id]) }, detachSession: async id => { workspaceActions.push(['detach', id]) } }] },
    get: key => key === 'connection' ? { fetch: { register: value => { route = value } } }
      : key === 'agentPresets' ? { resolve: async id => ({ id: id ?? 'default' }), mount: async (_ctx, id) => { mounted.push(id) } } : services.get(key),
  }
  apply(ctx)
  const request = async operation => {
    const response = await route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, {
      method: 'POST', body: JSON.stringify(operation), headers: { 'content-type': 'application/json' },
    }))
    const value = await response.json()
    assert.equal(response.status, 200, JSON.stringify(value))
    return value
  }
  const timeline = async id => {
    const response = await route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}?sessionId=${id}`))
    const value = await response.json()
    assert.equal(response.status, 200, JSON.stringify(value))
    return value
  }
  const cold = id => {
    validateStoredEvents(getLog(id).session, structuredClone(getLog(id).events))
    logs.set(id, structuredClone(getLog(id)))
    agents.delete(id)
    if (core.sessions.get(id)) detachers.get(id)()
  }
  return { source, ctx, route, children, mounted, workspaceActions, followups, services, request, timeline, cold }
}

const imageBlock = (name = '原图片.png', id = 'a') => ({
  type: 'image', offloaded: true,
  attachment: { attachmentId: id.repeat(64), mediaType: 'image/png', bytes: 16, width: 2, height: 2, name,
    originalDimensions: { width: 4, height: 4 } },
})
const fileBlock = (name = '原文件.txt', id = 'b') => ({
  type: 'file', attachment: { attachmentId: id.repeat(64), bytes: 7, name },
})

function attachmentServices(f) {
  const admissions = []
  const bindings = []
  const storedFiles = new Map([['uploaded-file', fileBlock('新文件.csv', 'd').attachment]])
  f.services.set('attachments', {
    imageLimits: { maxImagesPerMessage: 8, maxMessageImageBytes: 1024 },
    admitPromptContent: async content => {
      admissions.push(structuredClone(content))
      return content.map(part => part.type === 'image' ? {
        type: 'image', attachment: imageBlock(part.name, 'c').attachment,
      } : structuredClone(part))
    },
  })
  f.services.set('fileUploads', {
    resolve: (agent, receiptId) => agent.id === 'source' ? storedFiles.get(receiptId) : undefined,
    bindPrompt: (agent, receiptIds, requestId) => {
      const record = { sessionId: agent.id, receiptIds, requestId, committed: false, disposed: false }
      bindings.push(record)
      return { commit: () => { record.committed = true }, [Symbol.dispose]: () => { record.disposed = true } }
    },
    retirePrompt: (agent, requestId) => {
      const record = bindings.find(binding => binding.sessionId === agent.id && binding.requestId === requestId)
      record.retired = true
      for (const receiptId of record.receiptIds) storedFiles.delete(receiptId)
    },
  })
  return { admissions, bindings, storedFiles }
}

function composerServices(f) {
  const modelCalls = []
  const permissionCalls = []
  const opened = []
  const referenceCalls = []
  const resolvedPaths = []
  const currentPermissions = new Map([['source', 'workspace-write']])
  const permissionOptions = [{ value: 'workspace-write', name: '默认权限' },
    { value: 'danger-full-access', name: '完全权限', description: '允许完整文件访问' }]
  const modelCatalog = { default: { provider: 'test', model: 'test-model' }, groups: [{ id: 'test', name: '测试提供方', models: [
    { id: 'test-model', name: '原模型' },
    { id: 'new-model', name: '新模型', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] } },
  ] }], routableProviders: ['test'], failures: [] }
  const controller = {
    modelCatalog: async () => structuredClone(modelCatalog),
    projections: async ({ sessionId }) => ({ asOfSeq: 0, values: {
      permissions: { currentValue: currentPermissions.get(sessionId) ?? 'workspace-write' },
    } }),
    selectModel: async request => {
      modelCalls.push(structuredClone(request))
      const { sessionId, ...selection } = request
      f.ctx.agents.get(sessionId).session.append('model/selection', selection)
      return { selected: selection }
    },
    openWorkspacePath: async (request, signal) => {
      signal.throwIfAborted()
      if (request.path.includes('missing')) throw new Error('路径没有可验证的宿主映射')
      opened.push(structuredClone(request))
      return { opened: true }
    },
  }
  f.services.set('sessionController', controller)
  f.services.set('permissionPresets', {
    catalog: () => ({ options: permissionOptions, defaultPreset: 'workspace-write' }),
    resolve: name => permissionOptions.find(option => option.value === name),
    set: (session, name) => { permissionCalls.push({ sessionId: session.id, preset: name }); currentPermissions.set(session.id, name) },
  })
  f.services.set('fileReferences', { list: async (agent, query, signal) => {
    signal.throwIfAborted()
    referenceCalls.push({ sessionId: agent.id, query })
    return [{ path: '说明.txt', kind: 'file' }, { path: '资料/', kind: 'directory' }]
  } })
  f.services.set('fs', {
    resolve: async (path, options) => {
      options.signal.throwIfAborted()
      resolvedPaths.push({ path, cwd: options.cwd })
      return windowsPath.resolve(options.cwd ?? 'D:\\workspace', path)
    },
    processPath: target => target,
  })
  const attachmentStore = f.services.get('attachments') ?? {}
  f.services.set('attachments', { ...attachmentStore, fileHostPath: ref => `D:\\attachments\\${ref.attachmentId}\\${ref.name}` })
  return { modelCalls, permissionCalls, opened, referenceCalls, resolvedPaths }
}

async function postResponse(f, operation) {
  return f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, {
    method: 'POST', body: JSON.stringify(operation), headers: { 'content-type': 'application/json' },
  }))
}

async function composerGet(f, view, query = '') {
  const response = await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}?${new URLSearchParams({ sessionId: 'source', view, query })}`))
  const value = await response.json()
  assert.equal(response.status, 200, JSON.stringify(value))
  return value
}

test('编辑助手回复：正确分支、清空旧队列、保留原会话并挂载原 preset', async () => {
  const f = fixture()
  const original = structuredClone(f.source.snapshotEvents())
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'assistant.response')
  const result = await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '修改后的回复', cascade: 'truncate' })
  const child = f.children[0]
  assert.equal(result.queuedTurns, 0)
  assert.deepEqual(f.source.snapshotEvents(), original)
  assert.equal(child.agent.session.header.isSeeded, true)
  assert.equal(child.agent.session.header.agentPreset, 'roleplay')
  assert.deepEqual(f.mounted, ['roleplay'])
  const events = child.agent.session.snapshotEvents()
  const boundary = child.agent.session.inheritedEventCount
  assert.equal(events[boundary].type, 'session/end-seed')
  assert.equal(events[boundary].data.inherited, true)
  assert.ok(events.some(e => e.type === 'agent/inbox/spliced' && e.data.outcome === 'canceled'))
  const version = events.find(e => e.type === 'message-edit/version')
  assert.equal(version.ignorable, true)
  const view = await f.timeline(result.sessionId)
  assert.equal(view.messages.find(m => m.kind === 'assistant.response').text, '修改后的回复')
  assert.deepEqual(view.undoStack, ['source'])
  assert.deepEqual((await f.timeline('source')).redoSessionIds, [result.sessionId])
})

test('编辑用户输入并保留后续：只排入新输入与后续用户输入', async () => {
  const f = fixture()
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user')
  const result = await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '新问题', cascade: 'preserve' })
  assert.equal(result.queuedTurns, 2)
  assert.deepEqual(f.children[0].queued.map(m => m.content[0].text), ['新问题', '用户输入 2'])
  assert.equal(f.children[0].agent.session.snapshotEvents().some(e => e.type === 'assistant/message'), false)
})

test('用户消息只保存：当前会话更新上下文，不创建或挂接新会话，保留全部已有回复', async () => {
  const f = fixture()
  const original = structuredClone(f.source.snapshotEvents())
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user')
  const result = await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '仅修改文本' })
  assert.deepEqual(result, { sessionId: 'source', queuedTurns: 0, saved: true })
  assert.equal(f.children.length, 0)
  assert.deepEqual(f.workspaceActions, [])
  assert.deepEqual(f.mounted, [])
  const changed = f.source.snapshotEvents()
  assert.deepEqual(changed.slice(0, original.length), original)
  assert.equal(changed.length, original.length + 1)
  const replacement = changed.at(-1)
  assert.equal(replacement.type, 'user/message')
  assert.equal(replacement.data.id, original[block.eventSeq].data.id)
  assert.equal(replacement.data.content[0].text, '仅修改文本')
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: block.eventSeq, endSeq: block.eventSeq })
  assert.deepEqual(replacement.sourceEventSeqs, [block.eventSeq])
  assert.equal(f.source.deriveMessages().find(m => m.role === 'user').content[0].text, '仅修改文本')
  validateStoredEvents(f.source.header, structuredClone(changed))
  const view = await f.timeline(result.sessionId)
  assert.equal(view.messages.filter(m => m.kind === 'user').length, 2)
  assert.equal(view.messages.find(m => m.turn === 2 && m.kind === 'assistant.response').text, '回复 2')
  assert.equal(view.messages.find(m => m.kind === 'user').text, '仅修改文本')
  assert.deepEqual(view.undoStack, [])
  assert.equal(view.versions.length, 1)
})

test('文本保存未传附件时保留完整图片和文件，冷恢复后模型与 Timeline 一致', async () => {
  const initialContent = [imageBlock(), { type: 'text', text: '附件说明' }, fileBlock()]
  const f = fixture([initialContent])
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  assert.deepEqual(block.content, initialContent)
  assert.deepEqual(block.attachments, [{ blockIndex: 0, content: initialContent[0] }, { blockIndex: 2, content: initialContent[2] }])
  const original = structuredClone(f.source.snapshotEvents())
  await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '只改说明' })
  const expected = [imageBlock(), { type: 'text', text: '只改说明' }, fileBlock()]
  assert.deepEqual(f.source.deriveMessages().find(message => message.role === 'user').content, expected)
  assert.deepEqual(f.source.snapshotEvents().slice(0, original.length), original)
  assert.equal(f.children.length, 0)
  assert.deepEqual(f.followups, [])
  f.cold('source')
  const stored = await f.ctx.sessionQuery.readSession('source')
  const restored = f.ctx.sessions.prepare('source', { seed: stored.events, meta: stored.session, inheritedEventCount: stored.inheritedEventCount })
  assert.deepEqual(restored.deriveMessages().find(message => message.role === 'user').content, expected)
  const view = await f.timeline('source')
  assert.deepEqual(view.messages.find(message => message.kind === 'user').content, expected)
  assert.equal(view.messages.find(message => message.turn === 2 && message.kind === 'assistant.response').text, '回复 2')
})

test('显式空附件数组删除全部附件，后续省略附件和重试仍使用最新内容', async () => {
  const f = fixture([[{ type: 'text', text: '说明' }, imageBlock(), fileBlock()]])
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '去掉附件', attachments: [] })
  await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '继续编辑' })
  const content = [{ type: 'text', text: '继续编辑' }]
  assert.deepEqual(f.source.deriveMessages().find(message => message.role === 'user').content, content)
  const changed = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  assert.deepEqual(changed.content, content)
  assert.deepEqual(changed.attachments, [])
  assert.deepEqual(f.followups, [])
  await f.request({ action: 'retry', sessionId: 'source', turn: 1, cascade: 'truncate' })
  assert.deepEqual(f.children[0].queued[0].content, content)
})

test('附件原地编辑：保留已有块、新图准入和文件凭据解析后保存，不调用模型', async () => {
  const f = fixture([[{ type: 'text', text: '旧说明' }, imageBlock(), fileBlock()]])
  const services = attachmentServices(f)
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const original = structuredClone(f.source.snapshotEvents())
  const result = await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '', attachments: [
    { type: 'retained', blockIndex: 2 },
    { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=', name: '新图片.png' },
    { type: 'file', receiptId: 'uploaded-file' },
  ] })
  assert.deepEqual(result, { sessionId: 'source', queuedTurns: 0, saved: true })
  assert.equal(f.children.length, 0)
  assert.deepEqual(f.followups, [])
  assert.deepEqual(f.source.snapshotEvents().slice(0, original.length), original)
  const expected = [{ type: 'text', text: '' }, fileBlock(),
    { type: 'image', attachment: imageBlock('新图片.png', 'c').attachment }, fileBlock('新文件.csv', 'd')]
  assert.deepEqual(f.source.deriveMessages().find(message => message.role === 'user').content, expected)
  const view = await f.timeline('source')
  assert.deepEqual(view.messages.find(message => message.kind === 'user').content, expected)
  assert.deepEqual(services.admissions, [[
    { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=', name: '新图片.png' },
    { type: 'file', attachment: fileBlock('新文件.csv', 'd').attachment },
  ]])
  assert.equal(services.bindings.length, 1)
  assert.equal(services.bindings[0].sessionId, 'source')
  assert.equal(services.bindings[0].committed, true)
  assert.equal(services.bindings[0].retired, true)
  assert.equal(services.bindings[0].disposed, true)
  assert.equal(services.storedFiles.has('uploaded-file'), false)
  validateStoredEvents(f.source.header, structuredClone(f.source.snapshotEvents()))
  f.cold('source')
  await f.request({ action: 'retry', sessionId: 'source', turn: 1, cascade: 'truncate' })
  assert.deepEqual(f.children[0].queued[0].content, expected)
})

test('保存并发送将编辑后的附件排入新输入，省略附件同样保留原附件', async () => {
  const f = fixture([[{ type: 'text', text: '旧问题' }, imageBlock(), fileBlock()]])
  attachmentServices(f)
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const original = structuredClone(f.source.snapshotEvents())
  await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '', cascade: 'truncate', regenerate: true,
    attachments: [{ type: 'retained', blockIndex: 1 }, { type: 'file', receiptId: 'uploaded-file' }] })
  assert.deepEqual(f.children[0].queued[0].content, [{ type: 'text', text: '' }, imageBlock(), fileBlock('新文件.csv', 'd')])
  assert.deepEqual(f.source.snapshotEvents(), original)
  await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '保留附件再发送', cascade: 'truncate' })
  assert.deepEqual(f.children[1].queued[0].content, [{ type: 'text', text: '保留附件再发送' }, imageBlock(), fileBlock()])
})

test('仅附件消息可以编辑，正文为空仍可保存或发送，清空正文和全部附件时拒绝', async () => {
  const f = fixture([[imageBlock(), fileBlock()]])
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  assert.equal(block.text, '')
  assert.equal(block.blockIndex, 2)
  await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '', attachments: [{ type: 'retained', blockIndex: 0 }] })
  assert.deepEqual(f.source.deriveMessages().find(message => message.role === 'user').content, [imageBlock()])
  assert.deepEqual(f.followups, [])
  const nextBlock = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  assert.equal(nextBlock.blockIndex, 1)
  const before = structuredClone(f.source.snapshotEvents())
  const rejected = await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, { method: 'POST', body: JSON.stringify({
    action: 'save', sessionId: 'source', eventSeq: nextBlock.eventSeq, blockIndex: nextBlock.blockIndex, text: ' ', attachments: [],
  }) }))
  assert.equal(rejected.status, 400)
  assert.deepEqual(f.source.snapshotEvents(), before)
  await f.request({ action: 'edit', sessionId: 'source', eventSeq: nextBlock.eventSeq, blockIndex: nextBlock.blockIndex, text: '', cascade: 'truncate' })
  assert.deepEqual(f.children[0].queued[0].content, [imageBlock()])
})

test('附件输入拒绝伪造持久引用、非附件保留位置和未知文件凭据，失败不写日志', async () => {
  const f = fixture([[{ type: 'text', text: '原问题' }, imageBlock()]])
  const services = attachmentServices(f)
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const original = structuredClone(f.source.snapshotEvents())
  for (const attachments of [
    null,
    [{ type: 'retained', blockIndex: 0 }],
    [{ type: 'retained', blockIndex: -1 }],
    [{ type: 'image', attachment: imageBlock().attachment }],
    [{ type: 'image', mediaType: 'image/svg+xml', data: 'PHN2Zy8+' }],
    [{ type: 'file', attachment: fileBlock().attachment }],
    [{ type: 'file', receiptId: 'other-session-file' }],
  ]) {
    const response = await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, { method: 'POST', body: JSON.stringify({
      action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '新问题', attachments,
    }) }))
    assert.equal(response.status, 400)
  }
  assert.deepEqual(f.source.snapshotEvents(), original)
  assert.deepEqual(f.followups, [])
  assert.equal(f.children.length, 0)
  assert.deepEqual(services.admissions, [])
})

test('上传后分支失败会恢复文件凭据绑定，允许草稿重试', async () => {
  const f = fixture()
  const services = attachmentServices(f)
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const create = f.ctx.agents.create
  const operation = {
    action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '新问题', cascade: 'truncate',
    attachments: [{ type: 'file', receiptId: 'uploaded-file' }],
  }
  f.ctx.agents.create = async () => { throw new Error('模拟分支失败') }
  const response = await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, { method: 'POST', body: JSON.stringify(operation) }))
  assert.equal(response.status, 409)
  assert.equal(services.bindings[0].committed, false)
  assert.equal(services.bindings[0].disposed, true)
  assert.equal(services.bindings[0].retired, undefined)
  assert.equal(services.storedFiles.has('uploaded-file'), true)
  assert.equal(f.children.length, 0)
  assert.deepEqual(f.followups, [])
  f.ctx.agents.create = create
  await f.request(operation)
  assert.deepEqual(f.children[0].queued[0].content, [{ type: 'text', text: '新问题' }, fileBlock('新文件.csv', 'd')])
  assert.equal(services.bindings[1].committed, true)
  assert.equal(services.bindings[1].retired, true)
  assert.equal(services.storedFiles.has('uploaded-file'), false)
})

test('仅保存落盘失败保留文件凭据，同一草稿再次保存可成功', async () => {
  const f = fixture()
  const services = attachmentServices(f)
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const operation = { action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: '新问题', attachments: [{ type: 'file', receiptId: 'uploaded-file' }] }
  const flush = f.ctx.sessions.flush
  f.ctx.sessions.flush = async () => { throw new Error('模拟存储暂时失败') }
  const response = await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, { method: 'POST', body: JSON.stringify(operation) }))
  assert.equal(response.status, 409)
  assert.equal(services.bindings[0].committed, false)
  assert.equal(services.bindings[0].disposed, true)
  assert.equal(services.storedFiles.has('uploaded-file'), true)
  f.ctx.sessions.flush = flush
  await f.request(operation)
  assert.deepEqual(f.source.deriveMessages().find(message => message.role === 'user').content,
    [{ type: 'text', text: '新问题' }, fileBlock('新文件.csv', 'd')])
  assert.equal(services.bindings[1].committed, true)
  assert.equal(services.bindings[1].retired, true)
  assert.equal(f.children.length, 0)
  assert.deepEqual(f.followups, [])
  validateStoredEvents(f.source.header, structuredClone(f.source.snapshotEvents()))
})

test('新图片准入失败或保留加新增超过总限制时，不写编辑事件', async () => {
  const f = fixture([[{ type: 'text', text: '原问题' }, imageBlock()]])
  attachmentServices(f)
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const original = structuredClone(f.source.snapshotEvents())
  const operation = { action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '新问题',
    attachments: [{ type: 'retained', blockIndex: 1 }, { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' }] }
  const store = f.services.get('attachments')
  const admit = store.admitPromptContent
  store.admitPromptContent = async () => { throw new Error('模拟图片校验失败') }
  const post = () => f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, { method: 'POST', body: JSON.stringify(operation) }))
  assert.equal((await post()).status, 409)
  store.admitPromptContent = admit
  store.imageLimits.maxImagesPerMessage = 1
  assert.equal((await post()).status, 409)
  assert.deepEqual(f.source.snapshotEvents(), original)
  assert.equal(f.children.length, 0)
  assert.deepEqual(f.followups, [])
})

test('只保存后冷恢复并连续保存：仍在原会话，替换最新节点且全部回合保持完整', async () => {
  const f = fixture()
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user')
  const first = await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '第一次保存' })
  const firstReplacement = f.source.snapshotEvents().at(-1)
  f.cold(first.sessionId)
  const second = await f.request({ action: 'save', sessionId: first.sessionId, eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '第二次保存' })
  const stored = await f.ctx.sessionQuery.readSession('source')
  const restored = f.ctx.sessions.prepare('source', { seed: stored.events, meta: stored.session, inheritedEventCount: stored.inheritedEventCount })
  assert.equal(restored.deriveMessages().find(m => m.role === 'user').content[0].text, '第二次保存')
  assert.deepEqual(restored.snapshotEvents().findLast(event => event.type === 'user/message').surfaceOp, { op: 'replace', startSeq: firstReplacement.seq, endSeq: firstReplacement.seq })
  assert.equal(first.sessionId, 'source')
  assert.equal(second.sessionId, 'source')
  assert.equal(f.children.length, 0)
  f.cold(second.sessionId)
  const view = await f.timeline(second.sessionId)
  assert.equal(view.messages.find(m => m.kind === 'user').text, '第二次保存')
  assert.equal(view.retryableTurns.length, 2)
  assert.deepEqual(view.undoStack, [])
  assert.equal(view.versions.length, 1)
  assert.equal(view.messages.find(m => m.turn === 2 && m.kind === 'assistant.response').text, '回复 2')
})

test('旧调用方 regenerate false 也只保存；助手消息和失效上下文位置拒绝原地保存', async () => {
  const f = fixture()
  const messages = (await f.timeline('source')).messages
  const user = messages.find(m => m.kind === 'user')
  await f.request({ action: 'edit', sessionId: 'source', eventSeq: user.eventSeq, blockIndex: user.blockIndex, text: '兼容保存', cascade: 'truncate', regenerate: false })
  const post = operation => f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, { method: 'POST', body: JSON.stringify(operation) }))
  const assistant = messages.find(m => m.kind === 'assistant.response')
  assert.equal((await post({ action: 'save', sessionId: 'source', eventSeq: assistant.eventSeq, blockIndex: assistant.blockIndex, text: '无效' })).status, 409)
  const current = f.source.snapshotEvents().at(-1)
  f.source.append('user/message', { ...current.data, source: { kind: 'user' } }, { surfaceOp: { op: 'replace', startSeq: current.seq, endSeq: current.seq }, sourceEventSeqs: [current.seq] })
  assert.equal((await post({ action: 'save', sessionId: 'source', eventSeq: user.eventSeq, blockIndex: user.blockIndex, text: '已压缩' })).status, 409)
  assert.equal(f.children.length, 0)
})

test('原地保存后重试与编辑分支使用最新文本，保留先前修改的模型上下文', async () => {
  const f = fixture()
  const messages = (await f.timeline('source')).messages
  const user = messages.find(m => m.kind === 'user')
  await f.request({ action: 'save', sessionId: 'source', eventSeq: user.eventSeq, blockIndex: user.blockIndex, text: '已保存问题' })
  await f.request({ action: 'retry', sessionId: 'source', turn: 1, cascade: 'truncate' })
  assert.equal(f.children[0].queued[0].content[0].text, '已保存问题')
  const assistant = messages.find(m => m.turn === 2 && m.kind === 'assistant.response')
  const result = await f.request({ action: 'edit', sessionId: 'source', eventSeq: assistant.eventSeq, blockIndex: assistant.blockIndex, text: '第二回合新回复', cascade: 'truncate' })
  const child = f.children[1].agent.session
  assert.equal(child.deriveMessages().find(m => m.role === 'user').content[0].text, '已保存问题')
  const childUser = (await f.timeline(result.sessionId)).messages.find(m => m.kind === 'user')
  await f.request({ action: 'save', sessionId: result.sessionId, eventSeq: childUser.eventSeq, blockIndex: childUser.blockIndex, text: '分支内仅保存' })
  assert.equal(child.deriveMessages().find(m => m.role === 'user').content[0].text, '分支内仅保存')
  assert.equal(f.source.deriveMessages().find(m => m.role === 'user').content[0].text, '已保存问题')
  assert.equal(f.children.length, 2)
})

test('切点包含早期保存而不含最新保存时，分支继承原日志并使用最新文本', async () => {
  const f = fixture([[{ type: 'text', text: '原问题' }, imageBlock(), fileBlock()]])
  attachmentServices(f)
  const user = (await f.timeline('source')).messages.find(m => m.kind === 'user')
  const save = (text, attachments) => f.request({ action: 'save', sessionId: 'source', eventSeq: user.eventSeq, blockIndex: user.blockIndex, text, attachments })
  await save('早期保存', [])
  const sourcePrefix = structuredClone(f.source.snapshotEvents())
  f.source.append('turn/start', { turn: 3 })
  f.source.append('user/message', { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '第三回合' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  f.source.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  await save('最新保存', [{ type: 'file', receiptId: 'uploaded-file' }])
  const result = await f.request({ action: 'retry', sessionId: 'source', turn: 3, cascade: 'truncate' })
  const child = f.children[0].agent.session
  assert.deepEqual(child.snapshotEvents().slice(0, child.inheritedEventCount), sourcePrefix)
  assert.equal(child.deriveMessages().find(m => m.role === 'user').content[0].text, '最新保存')
  assert.deepEqual(child.deriveMessages().find(m => m.role === 'user').content,
    [{ type: 'text', text: '最新保存' }, fileBlock('新文件.csv', 'd')])
  assert.equal((await f.timeline(result.sessionId)).messages.find(m => m.kind === 'user').text, '最新保存')
  assert.deepEqual((await f.timeline(result.sessionId)).messages.find(m => m.kind === 'user').attachments,
    [{ blockIndex: 1, content: fileBlock('新文件.csv', 'd') }])
  assert.equal(f.children[0].queued[0].content[0].text, '第三回合')
})

test('保存并发送排入修改后的输入，拒绝非布尔 regenerate 参数', async () => {
  const f = fixture()
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user')
  const operation = { action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '修改后发送', cascade: 'truncate', regenerate: true }
  const result = await f.request(operation)
  assert.equal(result.queuedTurns, 1)
  assert.equal(f.children[0].queued[0].content[0].text, '修改后发送')
  const invalid = await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, {
    method: 'POST', body: JSON.stringify({ ...operation, regenerate: 'false' }),
  }))
  assert.equal(invalid.status, 400)
  assert.equal(f.children.length, 1)
})

test('重生成最后回复和重试指定历史回合', async () => {
  const f = fixture()
  await f.request({ action: 'reroll', sessionId: 'source' })
  assert.deepEqual(f.children[0].queued.map(m => m.content[0].text), ['用户输入 2'])
  await f.request({ action: 'retry', sessionId: 'source', turn: 1, cascade: 'preserve' })
  assert.deepEqual(f.children[1].queued.map(m => m.content[0].text), ['用户输入 1', '用户输入 2'])
})

test('连续编辑和冷历史读取：继承效果不误算为新效果', async () => {
  const f = fixture()
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'assistant.response' && m.turn === 2)
  const first = await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '第一次', cascade: 'truncate' })
  const nextBlock = (await f.timeline(first.sessionId)).messages.find(m => m.kind === 'assistant.response' && m.turn === 2)
  const second = await f.request({ action: 'edit', sessionId: first.sessionId, eventSeq: nextBlock.eventSeq, blockIndex: nextBlock.blockIndex, text: '第二次', cascade: 'truncate' })
  f.cold(first.sessionId)
  f.cold(second.sessionId)
  const view = await f.timeline(second.sessionId)
  assert.deepEqual(view.undoStack, [first.sessionId, 'source'])
  assert.equal(view.versions.length, 3)
  assert.equal(view.messages.find(m => m.kind === 'assistant.response' && m.turn === 2).text, '第二次')
})

test('冷会话编辑时恢复原 preset', async () => {
  const f = fixture()
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'assistant.reasoning')
  f.cold('source')
  await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '新思考', cascade: 'truncate' })
  assert.deepEqual(f.mounted, ['roleplay', 'roleplay'])
})

test('拒绝非法 JSON、非法事件位置和未结束回合', async () => {
  const f = fixture()
  const invalid = await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, { method: 'POST', body: '{' }))
  assert.equal(invalid.status, 400)
  const missing = await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, { method: 'POST', body: JSON.stringify({ action: 'edit', sessionId: 'source', eventSeq: 999, blockIndex: 0, text: '无效', cascade: 'truncate' }) }))
  assert.equal(missing.status, 409)
  f.source.append('turn/start', { turn: 3 })
  f.source.append('user/message', { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '尚未结束' }] }, { surfaceOp: 'append' })
  assert.equal((await f.timeline('source')).messages.some(m => m.text === '尚未结束'), false)
  assert.equal(f.children.length, 0)
})

test('读取编辑器选项和文件候选不改变会话、不发送模型请求', async () => {
  const f = fixture()
  const services = composerServices(f)
  const original = structuredClone(f.source.snapshotEvents())
  const options = await composerGet(f, 'options')
  assert.deepEqual(options.current, { provider: 'test', model: 'test-model', permissionPreset: 'workspace-write' })
  assert.deepEqual(options.models, [
    { provider: 'test', providerLabel: '测试提供方', model: 'test-model', label: '原模型', reasoningEfforts: [] },
    { provider: 'test', providerLabel: '测试提供方', model: 'new-model', label: '新模型', reasoningEfforts: ['low', 'high'], reasoningEffortLabels: { low: '低', high: '高' } },
  ])
  assert.deepEqual(options.permissions.map(option => option.id), ['workspace-write', 'danger-full-access'])
  assert.deepEqual(await composerGet(f, 'references', '说明'), [
    { path: '说明.txt', label: '说明.txt', kind: 'file' }, { path: '资料/', label: '资料/', kind: 'folder' },
  ])
  assert.deepEqual(services.referenceCalls, [{ sessionId: 'source', query: '说明' }])
  assert.deepEqual(services.modelCalls, [])
  assert.deepEqual(services.permissionCalls, [])
  assert.deepEqual(f.source.snapshotEvents(), original)
  assert.deepEqual(f.followups, [])
})

test('仅保存确认配置后只切换当前会话，正文、推理强度和权限同时保留', async () => {
  const f = fixture()
  const services = composerServices(f)
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const settings = { provider: 'test', model: 'new-model', reasoningEffort: 'high', permissionPreset: 'danger-full-access' }
  await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '仅保存配置与正文', settings })
  assert.deepEqual(services.modelCalls, [{ sessionId: 'source', provider: 'test', model: 'new-model', reasoningEffort: 'high' }])
  assert.deepEqual(services.permissionCalls, [{ sessionId: 'source', preset: 'danger-full-access' }])
  assert.deepEqual((await composerGet(f, 'options')).current, settings)
  assert.equal(f.source.snapshotEvents().at(-1).data.content[0].text, '仅保存配置与正文')
  assert.equal(f.children.length, 0)
  assert.deepEqual(f.followups, [])
  validateStoredEvents(f.source.header, structuredClone(f.source.snapshotEvents()))
})

test('保存并发送先给新分支应用模型和权限，来源会话保持原配置', async () => {
  const f = fixture()
  const services = composerServices(f)
  const original = structuredClone(f.source.snapshotEvents())
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const result = await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: '使用新配置发送', cascade: 'truncate', settings: { provider: 'test', model: 'new-model', permissionPreset: 'danger-full-access' } })
  assert.deepEqual(services.modelCalls, [{ sessionId: result.sessionId, provider: 'test', model: 'new-model' }])
  assert.deepEqual(services.permissionCalls, [{ sessionId: result.sessionId, preset: 'danger-full-access' }])
  assert.deepEqual(f.source.snapshotEvents(), original)
  assert.deepEqual(f.children[0].agent.session.snapshotEvents().at(-1).data, { provider: 'test', model: 'new-model' })
  assert.equal(f.children[0].queued[0].content[0].text, '使用新配置发送')
  assert.equal(services.modelCalls[0].reasoningEffort, undefined)
})

test('弹窗未重新选择模型时，分支沿用来源会话已选但尚未请求的模型和推理强度', async () => {
  const f = fixture()
  const services = composerServices(f)
  await f.services.get('sessionController').selectModel({ sessionId: 'source', provider: 'test', model: 'new-model', reasoningEffort: 'high' })
  services.modelCalls.length = 0
  const original = structuredClone(f.source.snapshotEvents())
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: '沿用已选择模型', cascade: 'truncate' })
  assert.deepEqual(f.children[0].agent.options, { provider: 'test', model: 'new-model', reasoningEffort: 'high' })
  assert.deepEqual(services.modelCalls, [])
  assert.deepEqual(f.source.snapshotEvents(), original)
})

test('新分支配置在首次落盘前应用，落盘失败清理分支并允许同一上传草稿重试', async () => {
  const f = fixture()
  const uploads = attachmentServices(f)
  composerServices(f)
  const original = structuredClone(f.source.snapshotEvents())
  const flush = f.ctx.sessions.flush
  const attempts = []
  f.ctx.sessions.flush = async session => {
    if (session.id !== 'source') {
      const selected = session.snapshotEvents().findLast(event => event.type === 'model/selection')
      attempts.push({ sessionId: session.id, selected: structuredClone(selected?.data) })
      if (attempts.length === 1) throw new Error('分支落盘失败')
    }
    return flush(session)
  }
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const operation = { action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: '配置及附件', cascade: 'truncate', attachments: [{ type: 'file', receiptId: 'uploaded-file' }],
    settings: { provider: 'test', model: 'new-model', reasoningEffort: 'high' } }
  assert.equal((await postResponse(f, operation)).status, 409)
  assert.deepEqual(attempts[0].selected, { provider: 'test', model: 'new-model', reasoningEffort: 'high' })
  assert.equal(f.ctx.agents.get(attempts[0].sessionId), undefined)
  assert.equal(f.ctx.sessions.get(attempts[0].sessionId), undefined)
  assert.equal(uploads.storedFiles.has('uploaded-file'), true)
  assert.equal(uploads.bindings[0].committed, false)
  assert.equal(uploads.bindings[0].disposed, true)
  assert.deepEqual(f.followups, [])
  assert.deepEqual(f.source.snapshotEvents(), original)
  const result = await f.request(operation)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[1].sessionId, result.sessionId)
  assert.equal(f.children[1].queued[0].content.some(part => part.type === 'file'), true)
  assert.equal(uploads.storedFiles.has('uploaded-file'), false)
})

test('无效模型、推理、权限或附件和助手配置请求都在改变设置前拒绝', async () => {
  const f = fixture()
  const services = composerServices(f)
  const original = structuredClone(f.source.snapshotEvents())
  const blocks = (await f.timeline('source')).messages
  const user = blocks.find(message => message.kind === 'user')
  const assistant = blocks.find(message => message.kind === 'assistant.response')
  const base = { action: 'save', sessionId: 'source', eventSeq: user.eventSeq, blockIndex: user.blockIndex, text: '不会保存' }
  for (const settings of [
    { provider: 'test' }, { reasoningEffort: 'high' },
    { provider: 'test', model: 'missing-model' }, { provider: 'test', model: 'new-model', reasoningEffort: 'unknown' },
    { permissionPreset: 'missing-preset' },
  ]) assert.equal((await postResponse(f, { ...base, settings })).status, 400)
  assert.equal((await postResponse(f, { ...base, attachments: [{ type: 'retained', blockIndex: 99 }],
    settings: { provider: 'test', model: 'new-model' } })).status, 400)
  assert.equal((await postResponse(f, { action: 'edit', sessionId: 'source', eventSeq: assistant.eventSeq,
    blockIndex: assistant.blockIndex, text: '助手回复', cascade: 'truncate', settings: { provider: 'test', model: 'new-model' } })).status, 400)
  assert.deepEqual(services.modelCalls, [])
  assert.deepEqual(services.permissionCalls, [])
  assert.deepEqual(f.source.snapshotEvents(), original)
  assert.equal(f.children.length, 0)
})

test('历史附件按当前保存投影和内容块定位，只打开真实文件，删除后不能打开旧附件', async () => {
  const f = fixture([[{ type: 'text', text: '说明' }, fileBlock(), imageBlock()]])
  attachmentServices(f)
  const services = composerServices(f)
  const block = (await f.timeline('source')).messages.find(message => message.kind === 'user')
  const operation = { action: 'open-attachment', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: 1 }
  await f.request(operation)
  assert.equal(services.opened[0].path.endsWith('原文件.txt'), true)
  await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: '更新文件', attachments: [{ type: 'file', receiptId: 'uploaded-file' }] })
  await f.request(operation)
  assert.equal(services.opened[1].path.endsWith('新文件.csv'), true)
  assert.equal((await postResponse(f, { ...operation, blockIndex: 99 })).status, 400)
  assert.equal((await postResponse(f, { ...operation, eventSeq: 999 })).status, 400)
  await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: '移除文件', attachments: [] })
  assert.equal((await postResponse(f, operation)).status, 400)
  assert.equal(services.opened.length, 2)
  assert.deepEqual(f.followups, [])
})

test('新上传文件只有所属会话的有效凭据可打开，打开不消费上传凭据', async () => {
  const f = fixture()
  const uploads = attachmentServices(f)
  const services = composerServices(f)
  await f.request({ action: 'open-upload', sessionId: 'source', receiptId: 'uploaded-file' })
  assert.equal(services.opened[0].path.endsWith('新文件.csv'), true)
  assert.equal(uploads.storedFiles.has('uploaded-file'), true)
  assert.deepEqual(uploads.bindings, [])
  const result = await f.request({ action: 'retry', sessionId: 'source', turn: 1, cascade: 'truncate' })
  assert.equal((await postResponse(f, { action: 'open-upload', sessionId: result.sessionId, receiptId: 'uploaded-file' })).status, 400)
  assert.equal((await postResponse(f, { action: 'open-upload', sessionId: 'source', receiptId: 'missing-receipt' })).status, 400)
  assert.equal(services.opened.length, 1)
})

test('文件引用从所属工作区解析，外部显式路径复用官方打开验证并传递失败', async () => {
  const f = fixture()
  const services = composerServices(f)
  const readSession = f.ctx.sessionQuery.readSession
  f.ctx.sessionQuery.readSession = async id => {
    const record = await readSession(id)
    return { ...record, session: { ...record.session, cwd: 'D:\\workspace' } }
  }
  const original = structuredClone(f.source.snapshotEvents())
  await f.request({ action: 'open-reference', sessionId: 'source', path: '资料\\说明.txt' })
  await f.request({ action: 'open-reference', sessionId: 'source', path: 'E:\\用户选择\\外部文件.pdf' })
  assert.deepEqual(services.opened, [{ path: 'D:\\workspace\\资料\\说明.txt' }, { path: 'E:\\用户选择\\外部文件.pdf' }])
  assert.deepEqual(services.resolvedPaths.map(item => item.cwd), ['D:\\workspace', 'D:\\workspace'])
  assert.equal((await postResponse(f, { action: 'open-reference', sessionId: 'source', path: 'missing.txt' })).status, 409)
  assert.equal((await postResponse(f, { action: 'open-reference', sessionId: 'source', path: '' })).status, 400)
  assert.equal(services.opened.length, 2)
  assert.deepEqual(f.source.snapshotEvents(), original)
  assert.deepEqual(f.followups, [])
})

test('正文和完整附件未改：不写事件、不落盘、不准入附件，连续保存仍然不变', async () => {
  const f = fixture([[{ type: 'text', text: '原问题' }, imageBlock(), { type: 'text', text: '第二段' }, fileBlock()]]);
  const services = attachmentServices(f);
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user');
  const before = structuredClone(f.source.snapshotEvents());
  let flushes = 0;
  f.ctx.sessions.flush = async () => { flushes++; };
  for (const attachments of [undefined, [{ type: 'retained', blockIndex: 1 }, { type: 'retained', blockIndex: 3 }]]) {
    const result = await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
      text: block.text, ...attachments === undefined ? {} : { attachments } });
    assert.deepEqual(result, { sessionId: 'source', queuedTurns: 0, saved: true, unchanged: true });
  }
  assert.deepEqual(f.source.snapshotEvents(), before);
  assert.equal(flushes, 0);
  assert.deepEqual(services.admissions, []);
  assert.deepEqual(f.followups, []);
  assert.equal(f.children.length, 0);
});

test('仅附件的无修改保存不会插入空文本块；只删附件仍保存完整内容', async () => {
  const f = fixture([[imageBlock(), fileBlock()]]);
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user');
  const before = structuredClone(f.source.snapshotEvents());
  assert.equal((await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: '', attachments: [{ type: 'retained', blockIndex: 0 }, { type: 'retained', blockIndex: 1 }] })).unchanged, true);
  assert.deepEqual(f.source.snapshotEvents(), before);
  assert.equal((await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: '', attachments: [{ type: 'retained', blockIndex: 1 }] })).unchanged, undefined);
  assert.deepEqual(f.source.deriveMessages().find(m => m.role === 'user').content, [fileBlock()]);
});

test('无修改以最新修订为准，冷恢复后不写记录；末尾空格视为真实修改', async () => {
  const f = fixture();
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user');
  const save = text => f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text });
  await save('已改正文');
  f.cold('source');
  const before = structuredClone((await f.ctx.sessionQuery.readSession('source')).events);
  assert.equal((await save('已改正文')).unchanged, true);
  assert.deepEqual((await f.ctx.sessionQuery.readSession('source')).events, before);
  assert.equal((await save('已改正文 ')).unchanged, undefined);
  assert.equal((await f.timeline('source')).messages.find(m => m.kind === 'user').text, '已改正文 ');
});

test('助手回复与思考未改时不创建版本、不丢后续对话，用户原文发送仍建分支', async () => {
  const f = fixture();
  const view = await f.timeline('source');
  const before = structuredClone(f.source.snapshotEvents());
  for (const block of view.messages.filter(m => m.kind !== 'user')) {
    const result = await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
      text: block.text, cascade: 'preserve' });
    assert.deepEqual(result, { sessionId: 'source', queuedTurns: 0, unchanged: true });
  }
  assert.equal(f.children.length, 0);
  assert.deepEqual(f.source.snapshotEvents(), before);
  const user = view.messages.find(m => m.kind === 'user');
  const sent = await f.request({ action: 'edit', sessionId: 'source', eventSeq: user.eventSeq, blockIndex: user.blockIndex,
    text: user.text, cascade: 'truncate', regenerate: true });
  assert.equal(sent.queuedTurns, 1);
  assert.notEqual(sent.sessionId, 'source');
});

test('仅修改模型、推理或权限不会被无修改判断吞掉，也不重复写用户消息', async () => {
  const f = fixture();
  const services = composerServices(f);
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user');
  const save = settings => f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: block.text, settings });
  const before = structuredClone(f.source.snapshotEvents());
  assert.equal((await save((await composerGet(f, 'options')).current)).unchanged, true);
  assert.deepEqual(f.source.snapshotEvents(), before);
  const settings = { provider: 'test', model: 'new-model', reasoningEffort: 'high', permissionPreset: 'danger-full-access' };
  assert.equal((await save(settings)).unchanged, undefined);
  assert.deepEqual((await composerGet(f, 'options')).current, settings);
  assert.equal(f.source.snapshotEvents().filter(e => e.type === 'user/message').length, 2);
  const changed = structuredClone(f.source.snapshotEvents());
  assert.equal((await save(settings)).unchanged, true);
  assert.deepEqual(f.source.snapshotEvents(), changed);
  assert.equal(services.modelCalls.length, 1);
  assert.equal(services.permissionCalls.length, 1);
  assert.equal((await save({ provider: 'test', model: 'new-model' })).unchanged, undefined);
  assert.equal((await composerGet(f, 'options')).current.reasoningEffort, undefined);
  assert.deepEqual(f.followups, []);
});

test('只读修订链解析连续保存，外部替换后标记失效；读取不写会话', async () => {
  const f = fixture();
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user');
  for (const text of ['第一次', '第二次']) await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text });
  const events = f.source.snapshotEvents();
  const revised = events.filter(e => e.type === 'user/message' && typeof e.surfaceOp === 'object');
  const get = async () => (await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}?view=revisions&sessionId=source`))).json();
  const before = structuredClone(events);
  const result = await get();
  assert.deepEqual(result.revisions, [{ originalEventSeq: block.eventSeq, replacementEventSeq: revised[1].seq,
    revisionEventSeqs: revised.map(e => e.seq), active: true }]);
  assert.deepEqual(result.replacements[1].shadowedEventSeqs, [revised[0].seq]);
  assert.deepEqual(f.source.snapshotEvents(), before);
  assert.equal(JSON.stringify(result).includes('第二次'), false);
  f.source.append('user/message', { ...revised[1].data, source: { kind: 'user' } }, {
    surfaceOp: { op: 'replace', startSeq: revised[1].seq, endSeq: revised[1].seq }, sourceEventSeqs: [revised[1].seq] });
  assert.equal((await get()).revisions[0].active, false);
});

test('诊断只报告构建和有限状态记录，不存正文、文件路径或异常详情', async () => {
  const f = fixture();
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user');
  for (let i = 0; i < 42; i++) await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex, text: block.text });
  await postResponse(f, { action: 'save', sessionId: 'source', eventSeq: 9999, blockIndex: 0, text: '绝密正文 D:/私人路径/文件.txt' });
  const before = structuredClone(f.source.snapshotEvents());
  const value = await (await f.route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}?view=diagnostics`))).json();
  assert.deepEqual(value.build, MESSAGE_EDIT_BUILD_INFO);
  assert.equal(value.recent.length, 40);
  assert.equal(value.recent.at(-1).code, 'operation-failed');
  assert.equal(value.recent[0].unchanged, true);
  assert.equal(JSON.stringify(value).includes('绝密正文'), false);
  assert.equal(JSON.stringify(value).includes('私人路径'), false);
  assert.deepEqual(f.source.snapshotEvents(), before);
});

test('未编辑的非附件内容块和交错顺序原样保留，正文变化只影响所选块', async () => {
  const content = [fileBlock(), { type: 'text', text: '第一段' }, { type: 'reasoning', text: '原有非附件块' }, imageBlock(), { type: 'text', text: '第二段' }];
  const f = fixture([content]);
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'user');
  await f.request({ action: 'save', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: '第一段已改', attachments: [{ type: 'retained', blockIndex: 0 }, { type: 'retained', blockIndex: 3 }] });
  assert.deepEqual(f.source.deriveMessages().find(m => m.role === 'user').content,
    [fileBlock(), { type: 'text', text: '第一段已改' }, content[2], imageBlock(), content[4]]);
  validateStoredEvents(f.source.header, structuredClone(f.source.snapshotEvents()));
});

test('冷助手回复未改时不恢复 Agent，也不创建任何版本', async () => {
  const f = fixture();
  const block = (await f.timeline('source')).messages.find(m => m.kind === 'assistant.response');
  f.cold('source');
  const before = structuredClone((await f.ctx.sessionQuery.readSession('source')).events);
  const result = await f.request({ action: 'edit', sessionId: 'source', eventSeq: block.eventSeq, blockIndex: block.blockIndex,
    text: block.text, cascade: 'truncate' });
  assert.equal(result.unchanged, true);
  assert.deepEqual(f.mounted, []);
  assert.equal(f.children.length, 0);
  assert.deepEqual((await f.ctx.sessionQuery.readSession('source')).events, before);
});
