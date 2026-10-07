import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import { apply, MESSAGE_EDIT_PATH } from '../index.mjs'

/** 内存句柄模拟持久化生命周期，Agent 的创建、恢复与消息投影仍使用真实 DSH。 */
function memoryPersistence(ctx) {
  const records = new Map()
  const writers = new Set()
  const append = (record, events) => {
    for (const event of events) {
      assert.equal(event.seq, record.events.length)
      record.events.push(structuredClone(event))
    }
  }
  const openHandle = (record, access = 'write') => {
    if (access === 'write') {
      assert.equal(writers.has(record.session.id), false)
      writers.add(record.session.id)
    }
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      if (access === 'write') writers.delete(record.session.id)
    }
    return {
      id: record.session.id, header: record.session,
      inheritedEventCount: record.inheritedEventCount, access,
      read: async (offset = 0, length) => ({
        eventState: 'detached',
        events: structuredClone(record.events.slice(offset, length === undefined ? undefined : offset + length)),
      }),
      append: async events => append(record, events),
      flush: async () => {}, close, [Symbol.asyncDispose]: close,
    }
  }
  ctx.provide('sessionPersistence', {
    create: async (header, options = {}) => {
      assert.equal(records.has(header.id), false)
      const record = { session: structuredClone(header), inheritedEventCount: options.inheritedEventCount ?? 0, events: [] }
      records.set(header.id, record)
      return openHandle(record)
    },
    open: async (id, access) => {
      const record = records.get(id)
      assert.ok(record, `持久化会话 ${id} 应当存在`)
      return openHandle(record, access)
    },
  })
  ctx.on('session/event', (session, event) => {
    const record = records.get(session.id)
    assert.ok(record)
    append(record, [event])
  })
  return records
}

test('真实 DSH AgentLoop：编辑助手消息后创建完整、空闲且可继续使用的分支', async () => {
  const ctx = new Context()
  new Projections(ctx)
  new Sessions(ctx)
  new Agents(ctx)
  new Llm(ctx)
  new Prompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new Tools(ctx)
  new Loop(ctx, { agents: [], maxParallelToolCalls: 10 })
  let route
  ctx.provide('connection', { fetch: { register: value => { route = value } } })
  ctx.provide('workspaceRegistry', { list: () => [] })
  ctx.provide('sessionQuery', { readSession: async id => {
    const session = ctx.sessions.get(id)
    return { session: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }
  } })
  try {
    const handle = await ctx.agents.create({ sessionId: 'source', agentOptions: { provider: 'test', model: 'test' } })
    const source = handle.agent.session
    const user = { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '测试问题' }], source: { kind: 'user' } }
    source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user] })
    source.append('turn/start', { turn: 1 })
    source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    source.append('user/message', user, { surfaceOp: 'append' })
    source.append('step/start', { turn: 1, step: 1 })
    const assistant = source.append('assistant/message', { turn: 1, step: 1, stream: [], message: {
      id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: '原回复' }], source: { kind: 'model', provider: 'test', model: 'test' },
    } }, { surfaceOp: 'append' })
    source.append('step/end', { turn: 1, step: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    apply(ctx)
    const response = await route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, { method: 'POST', body: JSON.stringify({
      action: 'edit', sessionId: source.id, eventSeq: assistant.seq, blockIndex: 0, text: '改好的回复', cascade: 'truncate',
    }) }))
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    const child = ctx.agents.get(result.sessionId)
    assert.equal(child.status, 'idle')
    assert.equal(ctx.sessionProjections.stateOf(child.session, 'turnBoundary').lastTurn, 1)
    assert.deepEqual(ctx.sessionProjections.stateOf(child.session, 'inbox'), { 'next-turn': [], 'next-step': [] })
    assert.equal(child.session.deriveMessages().find(m => m.role === 'assistant').content[0].text, '改好的回复')
    assert.equal(source.snapshotEvents().find(e => e.type === 'assistant/message').data.message.content[0].text, '原回复')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('真实 DSH AgentLoop：原会话保存及冷恢复均不调用模型，保存并发送仅调用一次', { timeout: 5000 }, async () => {
  const ctx = new Context()
  new Projections(ctx)
  new Sessions(ctx)
  new Agents(ctx)
  new Llm(ctx)
  new Prompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new Tools(ctx)
  new Loop(ctx, { agents: [], maxParallelToolCalls: 10 })
  const records = memoryPersistence(ctx)
  const created = []
  ctx.on('agent/created', ({ agent, source }) => { if (source === 'startup') created.push(agent.id) })
  const calls = []
  class TestAdapter extends LlmAdapter {
    async *stream(options) {
      calls.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '新回复' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '新回复' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new TestAdapter())
  let route
  ctx.provide('connection', { fetch: { register: value => { route = value } } })
  ctx.provide('workspaceRegistry', { list: () => [] })
  ctx.provide('sessionQuery', { readSession: async id => {
    const session = ctx.sessions.get(id)
    return session === undefined ? structuredClone(records.get(id))
      : { session: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }
  } })
  try {
    const handle = await ctx.agents.create({ sessionId: 'source', agentOptions: { provider: 'test', model: 'test' } })
    const source = handle.agent.session
    source.append('turn/start', { turn: 1 })
    const user = source.append('user/message', {
      id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '原问题' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    source.append('step/start', { turn: 1, step: 1 })
    source.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'test' } } })
    source.append('assistant/message', { turn: 1, step: 1, stream: [], message: {
      id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: '原回复' }], source: { kind: 'model', provider: 'test', model: 'test' },
    } }, { surfaceOp: 'append' })
    source.append('step/end', { turn: 1, step: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    source.append('turn/start', { turn: 2 })
    source.append('user/message', {
      id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: '后续问题' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    source.append('step/start', { turn: 2, step: 1 })
    source.append('assistant/message', { turn: 2, step: 1, stream: [], message: {
      id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: '后续回复' }], source: { kind: 'model', provider: 'test', model: 'test' },
    } }, { surfaceOp: 'append' })
    source.append('step/end', { turn: 2, step: 1 })
    source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const originalPrefix = structuredClone(source.snapshotEvents())
    apply(ctx)
    const editUser = async (sessionId, send, text) => {
      const response = await route.fetch(new Request(`http://localhost${MESSAGE_EDIT_PATH}`, {
        method: 'POST', body: JSON.stringify({
          action: send ? 'edit' : 'save', sessionId, eventSeq: user.seq, blockIndex: 0, text,
          ...send ? { cascade: 'truncate', regenerate: true } : {},
        }),
      }))
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      return { ...result, agent: ctx.agents.get(result.sessionId) }
    }
    const unchanged = await editUser(source.id, false, '原问题')
    assert.equal(unchanged.unchanged, true)
    assert.deepEqual(source.snapshotEvents(), originalPrefix)
    assert.equal(calls.length, 0)
    const saved = await editUser(source.id, false, '只保存的问题')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls.length, 0)
    assert.equal(saved.sessionId, source.id)
    assert.equal(saved.queuedTurns, 0)
    assert.equal(saved.saved, true)
    assert.deepEqual(created, [source.id])
    assert.equal(saved.agent.status, 'idle')
    assert.deepEqual(saved.agent.session.deriveMessages().map(m => m.content[0].text), ['只保存的问题', '原回复', '后续问题', '后续回复'])
    assert.deepEqual(source.snapshotEvents().slice(0, originalPrefix.length), originalPrefix)
    assert.deepEqual(ctx.sessionProjections.stateOf(saved.agent.session, 'inbox'), { 'next-turn': [], 'next-step': [] })
    await handle.dispose()
    assert.equal(ctx.agents.get(source.id), undefined)
    const coldPrefix = structuredClone(records.get(source.id).events)
    assert.equal((await editUser(source.id, false, '只保存的问题')).unchanged, true)
    assert.deepEqual(records.get(source.id).events, coldPrefix)
    assert.equal(calls.length, 0)
    const coldSaved = await editUser(source.id, false, '冷恢复后只保存的问题')
    assert.equal(coldSaved.sessionId, source.id)
    assert.equal(coldSaved.queuedTurns, 0)
    assert.equal(coldSaved.saved, true)
    assert.equal(coldSaved.agent, undefined)
    assert.equal(calls.length, 0)
    assert.deepEqual(created, [source.id])
    assert.deepEqual(records.get(source.id).events.slice(0, originalPrefix.length), originalPrefix)
    const restored = await ctx.agents.resume({ resumeSessionId: source.id, agentOptions: { provider: 'test', model: 'test' } })
    assert.equal(restored.agent.session.id, source.id)
    assert.equal(restored.agent.status, 'idle')
    assert.deepEqual(restored.agent.session.deriveMessages().map(m => m.content[0].text), ['冷恢复后只保存的问题', '原回复', '后续问题', '后续回复'])
    assert.equal(calls.length, 0)
    const sent = await editUser(source.id, true, '冷恢复后只保存的问题')
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && (calls.length === 0 || sent.agent.status !== 'idle')) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(sent.queuedTurns, 1)
    assert.notEqual(sent.sessionId, source.id)
    assert.deepEqual(created, [source.id, sent.sessionId])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].messages.find(m => m.role === 'user').content[0].text, '冷恢复后只保存的问题')
    assert.equal(sent.agent.status, 'idle')
    assert.equal(sent.agent.session.deriveMessages().find(m => m.role === 'assistant').content[0].text, '新回复')
    assert.equal(restored.agent.session.deriveMessages().find(m => m.role === 'user').content[0].text, '冷恢复后只保存的问题')
    assert.deepEqual(restored.agent.session.snapshotEvents().slice(0, originalPrefix.length), originalPrefix)
  } finally {
    await ctx.fiber.dispose()
  }
})
