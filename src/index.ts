/// <reference lib="esnext.disposable" />
/** Host half of Message Edit: turn-atomic forks and structurally reversible versions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { ModelSelection, SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { AttachmentAdmissionPart, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { FileUploads, FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload'
import type { FileReferenceService } from '@deepseek-ai/dsh-file-reference'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { foldSurface, type SessionLogOffset, type SessionSeq, type SessionMessageProjection } from '@deepseek-ai/dsh-session'
import type {
  SessionId,
  Session,
  SessionEvent,
  SessionEventType,
  SurfaceEventType,
  SurfaceIntent,
} from '@deepseek-ai/dsh-session'
import type {
  SessionLineageNode,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
import type {
  AssistantMessage,
  ContentBlock,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { savedUserMessages, savedUserMessageSeq, visibleUserEvents, type SavedUserMessageSource } from './saved-user-messages.ts'
import { MESSAGE_EDIT_BUILD_INFO } from './build-info.ts'
import {
  MESSAGE_EDIT_PATH,
  MESSAGE_EDIT_VERSION_SCHEMA,
  type CascadePolicy,
  type EditOperation,
  type EditableBlockKind,
  type EditableMessageBlock,
  type LegacyMessageEditVersionEvent,
  type MessageEditEffect,
  type MessageEditOperation,
  type MessageEditAttachmentBlock,
  type MessageEditAttachmentInput,
  type MessageEditOperationResult,
  type MessageEditSettings,
  type MessageEditComposerOptions,
  type MessageEditReference,
  type MessageEditRevision,
  type MessageEditTimeline,
  type MessageEditVersionEvent,
  type RetryableTurn,
  type SaveOperation,
  type StoredMessageEditVersionEvent,
  type VersionSummary,
} from './shared.ts'

export {
  MESSAGE_EDIT_PATH,
  MESSAGE_EDIT_VERSION_SCHEMA,
  MESSAGE_EDIT_VIEW_ORDER,
} from './shared.ts'
export { MESSAGE_EDIT_BUILD_INFO } from './build-info.ts'
export type {
  CascadePolicy,
  EditOperation,
  EditableBlockKind,
  EditableMessageBlock,
  MessageEditOperation,
  MessageEditAttachmentBlock,
  MessageEditAttachmentInput,
  EditableMessageAttachment,
  MessageEditOperationResult,
  MessageEditSettings,
  MessageEditComposerOptions,
  MessageEditReference,
  MessageEditRevision,
  MessageEditBuildInfo,
  MessageEditTimeline,
  MessageEditEffect,
  MessageEditInverse,
  MessageEditVersionEvent,
  RerollOperation,
  RetryableTurn,
  RetryOperation,
  SaveOperation,
  VersionOperation,
  VersionSummary,
} from './shared.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Durable branch provenance owned by moeblack/message-edit. */
    'message-edit/version': StoredMessageEditVersionEvent
  }
}

/** Stable Cordis plugin name. */
export const name = 'message-edit'

/** Public services used by the branch transaction and timeline projection. */
export const inject = [
  'sessions',
  'agents',
  'sessionPersistence',
  'sessionQuery',
  'workspaceRegistry',
  'connection',
]

type UserEvent = SessionEvent<'user/message'>
type AssistantEvent = SessionEvent<'assistant/message'>

interface ClosedTurn {
  turn: number
  startSeq: number
  endSeq: number
  user?: UserEvent
  assistants: AssistantEvent[]
}

interface ManualAssistantTurn {
  turn: number
  user: UserMessage
  assistant: AssistantMessage
}

interface OperationPlan {
  boundary: number
  version: MessageEditVersionEvent
  manualTurn?: ManualAssistantTurn
  queuedUsers: UserMessage[]
}

interface VersionProjection {
  effect: MessageEditEffect
  inverseSessionId: string
  time: number
}

type MessageEditEffectDraft = Omit<MessageEditEffect, 'id'>

function pairVersionEffect(
  sourceSessionId: string,
  effect: MessageEditEffectDraft,
): MessageEditVersionEvent {
  return {
    schemaVersion: MESSAGE_EDIT_VERSION_SCHEMA,
    effect: { ...effect, id: crypto.randomUUID() },
    inverse: { kind: 'restore-version', sessionId: sourceSessionId },
  }
}

function isTextualBlock(block: ContentBlock | undefined): block is Extract<ContentBlock, { type: 'text' | 'reasoning' }> {
  return block?.type === 'text' || block?.type === 'reasoning'
}

function userText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function cloneUser(message: UserMessage, content: readonly ContentBlock[] = structuredClone(message.content)): UserMessage {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user' as const,
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'user' as const }),
  }) as UserMessage
}

function replaceTextBlock(content: readonly ContentBlock[], blockIndex: number, text: string): ContentBlock[] {
  const block = content[blockIndex]
  if (!isTextualBlock(block)) throw new Error('所选内容块不是可编辑文本。')
  return content.map((candidate, index) => index === blockIndex
    ? { ...candidate, text } as ContentBlock
    : structuredClone(candidate))
}

function isAttachmentBlock(block: ContentBlock | undefined): block is MessageEditAttachmentBlock {
  return block?.type === 'image' || block?.type === 'file'
}

/** 比较完整持久值，数组顺序有意义，对象属性顺序不构成修改。 */
function equalContentValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equalContentValue(value, right[index]))
  }
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(b, key) && equalContentValue(a[key], b[key]))
}

function replaceUserText(content: readonly ContentBlock[], blockIndex: number, text: string): ContentBlock[] {
  if (content[blockIndex]?.type === 'text') return replaceTextBlock(content, blockIndex, text)
  // 仅附件消息用内容末尾作为虚拟正文位置，保存后成为正常文本块。
  if (blockIndex === content.length && !content.some(block => block.type === 'text')) {
    if (text === '') return structuredClone(content) as ContentBlock[]
    return [...structuredClone(content), { type: 'text', text }]
  }
  throw new Error('所选用户消息块不是文本。')
}

function replaceUserAttachments(
  content: readonly ContentBlock[],
  attachments: readonly MessageEditAttachmentBlock[],
): ContentBlock[] {
  const result: ContentBlock[] = []
  const lastAttachment = content.findLastIndex(isAttachmentBlock)
  let next = 0
  for (const [index, block] of content.entries()) {
    if (!isAttachmentBlock(block)) result.push(structuredClone(block))
    else if (next < attachments.length) result.push(structuredClone(attachments[next++] as MessageEditAttachmentBlock))
    if (index === lastAttachment) {
      result.push(...structuredClone(attachments.slice(next)))
      next = attachments.length
    }
  }
  if (lastAttachment < 0) result.push(...structuredClone(attachments))
  return result
}

/** 先完成官方附件准入，再写消息；拒绝或上传失败不会留下半条编辑记录。 */
async function withEditedUserContent<T>(
  ctx: Context,
  agent: Agent,
  message: UserMessage,
  operation: SaveOperation | EditOperation,
  applyContent: (content: readonly ContentBlock[]) => Promise<T>,
): Promise<T> {
  let content = replaceUserText(message.content, operation.blockIndex, operation.text)
  const inputs = operation.attachments
  const receiptIds: FileUploadReceiptId[] = []
  let fileUploads: FileUploads | undefined
  if (inputs !== undefined) {
    const retained = new Map<number, MessageEditAttachmentBlock>()
    const admission: AttachmentAdmissionPart[] = []
    for (const [index, input] of inputs.entries()) {
      if (input.type === 'retained') {
        const block = message.content[input.blockIndex]
        if (!isAttachmentBlock(block)) throw new TypeError('保留的附件位置不存在或不是附件。')
        retained.set(index, structuredClone(block))
      } else if (input.type === 'file') {
        fileUploads ??= ctx.get('fileUploads') as FileUploads | undefined
        if (fileUploads === undefined) throw new Error('宿主未提供文件上传服务。')
        const receiptId = input.receiptId as FileUploadReceiptId
        const attachment = fileUploads.resolve(agent, receiptId)
        if (attachment === undefined) throw new TypeError('文件上传凭据不存在、已失效或不属于当前会话。')
        admission.push({ type: 'file', attachment })
        if (!receiptIds.includes(receiptId)) receiptIds.push(receiptId)
      } else {
        admission.push(input)
      }
    }
    const store = ctx.get('attachments') as AttachmentStore | undefined
    if (admission.length > 0 && store === undefined) throw new Error('宿主未提供附件存储服务。')
    const admitted = admission.length === 0 ? [] : await (store as AttachmentStore).admitPromptContent(admission)
    let next = 0
    const attachments = inputs.map((_input, index) => retained.get(index)
      ?? admitted[next++] as MessageEditAttachmentBlock)
    content = replaceUserAttachments(content, attachments)
    const images = attachments.filter(block => block.type === 'image')
    if (!equalContentValue(content, message.content) && store !== undefined && (images.length > store.imageLimits.maxImagesPerMessage
      || images.reduce((bytes, block) => bytes + block.attachment.bytes, 0) > store.imageLimits.maxMessageImageBytes)) {
      throw new Error('编辑后的图片数量或总大小超过宿主限制。')
    }
  }
  if (!content.some(block => isAttachmentBlock(block) || (block.type === 'text' && block.text.trim().length > 0))) {
    throw new TypeError('用户消息需要正文或至少一个附件。')
  }
  const requestId = crypto.randomUUID()
  const binding = receiptIds.length === 0 ? undefined : fileUploads?.bindPrompt(agent, receiptIds, requestId)
  try {
    const result = await applyContent(content)
    binding?.commit()
    if (binding !== undefined) fileUploads?.retirePrompt(agent, requestId)
    return result
  } finally {
    binding?.[Symbol.dispose]()
  }
}

/** Fold complete turn brackets; an open tail is deliberately absent. */
function closedTurns(events: readonly SessionEvent[]): ClosedTurn[] {
  const result: ClosedTurn[] = []
  let current: Omit<ClosedTurn, 'endSeq'> | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = {
        turn: event.data.turn,
        startSeq: event.seq,
        assistants: [],
      }
      continue
    }
    if (current === undefined) continue
    if (event.type === 'user/message'
      && current.user === undefined
      && event.data.source.kind === 'user') {
      current.user = event
      continue
    }
    if (event.type === 'assistant/message' && event.data.turn === current.turn) {
      current.assistants.push(event)
      continue
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      result.push({ ...current, endSeq: event.seq })
      current = undefined
    }
  }
  return result
}

function editableMessages(turns: readonly ClosedTurn[]): EditableMessageBlock[] {
  const result: EditableMessageBlock[] = []
  for (const turn of turns) {
    if (turn.user !== undefined) {
      const content = structuredClone(turn.user.data.content)
      const attachments = content.flatMap((block, blockIndex) => isAttachmentBlock(block) ? [{ blockIndex, content: block }] : [])
      const textBlocks = content.flatMap((block, blockIndex) => block.type === 'text' ? [{ blockIndex, text: block.text }] : [])
      if (textBlocks.length === 0 && attachments.length > 0) textBlocks.push({ blockIndex: content.length, text: '' })
      for (const { blockIndex, text } of textBlocks) {
        result.push({
          key: `${String(turn.user.seq)}:${String(blockIndex)}`,
          turn: turn.turn,
          eventSeq: turn.user.seq,
          blockIndex,
          kind: 'user',
          text,
          time: turn.user.time,
          content,
          attachments,
        })
      }
    }
    for (const event of turn.assistants) {
      for (const [blockIndex, block] of event.data.message.content.entries()) {
        if (!isTextualBlock(block)) continue
        result.push({
          key: `${String(event.seq)}:${String(blockIndex)}`,
          turn: turn.turn,
          eventSeq: event.seq,
          blockIndex,
          kind: block.type === 'reasoning' ? 'assistant.reasoning' : 'assistant.response',
          text: block.text,
          time: event.time,
        })
      }
    }
  }
  return result
}

function retryableTurns(turns: readonly ClosedTurn[]): RetryableTurn[] {
  return turns.flatMap((turn): RetryableTurn[] => turn.user === undefined ? [] : [{
    turn: turn.turn,
    userEventSeq: turn.user.seq,
    preview: userText(turn.user.data),
    time: turn.user.time,
  }])
}

function downstreamUsers(turns: readonly ClosedTurn[], start: number): UserMessage[] {
  return turns.slice(start).flatMap((turn): UserMessage[] => turn.user === undefined
    ? []
    : [cloneUser(turn.user.data)])
}

function assistantReplacement(event: AssistantEvent, blockIndex: number, text: string): AssistantMessage {
  const replaced = replaceTextBlock(event.data.message.content, blockIndex, text)
    .filter(block => block.type === 'text' || block.type === 'reasoning')
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'assistant' as const,
    content: Object.freeze(replaced),
    source: Object.freeze({
      kind: 'model' as const,
      provider: event.data.message.source.provider,
      model: event.data.message.source.model,
    }),
  }) as AssistantMessage
}

function editPlan(operation: EditOperation, turns: readonly ClosedTurn[], editedUserContent?: readonly ContentBlock[]): OperationPlan {
  const turnIndex = turns.findIndex(turn => operation.eventSeq > turn.startSeq && operation.eventSeq < turn.endSeq)
  const turn = turns[turnIndex]
  if (turn === undefined) throw new Error('所选消息不属于已落定回合。')
  const event = turn.user?.seq === operation.eventSeq
    ? turn.user
    : turn.assistants.find(candidate => candidate.seq === operation.eventSeq)
  if (event === undefined) throw new Error('所选消息不存在或不可编辑。')

  if (event.type === 'user/message') {
    const before = event.data.content[operation.blockIndex]
    const edited = cloneUser(event.data, editedUserContent ?? replaceUserText(event.data.content, operation.blockIndex, operation.text))
    const later = operation.cascade === 'preserve' ? downstreamUsers(turns, turnIndex + 1) : []
    return {
      boundary: turn.startSeq - 1,
      version: pairVersionEffect(operation.sessionId, {
        operation: 'edit',
        cascade: operation.cascade,
        regenerate: true,
        targetTurn: turn.turn,
        targetEventSeq: event.seq,
        targetBlockIndex: operation.blockIndex,
        blockKind: 'user',
        before: before?.type === 'text' ? before.text : '',
        after: operation.text,
      }),
      queuedUsers: [edited, ...later],
    }
  }

  const before = event.data.message.content[operation.blockIndex]
  if (!isTextualBlock(before)) throw new Error('所选助手消息块不是文本或思考。')
  const blockKind: EditableBlockKind = before.type === 'reasoning'
    ? 'assistant.reasoning'
    : 'assistant.response'
  if (turn.user === undefined) throw new Error('所选助手消息没有可重建的用户输入。')
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(operation.sessionId, {
      operation: 'edit',
      cascade: operation.cascade,
      targetTurn: turn.turn,
      targetEventSeq: event.seq,
      targetBlockIndex: operation.blockIndex,
      blockKind,
      before: before.text,
      after: operation.text,
    }),
    manualTurn: {
      turn: turn.turn,
      user: cloneUser(turn.user.data),
      assistant: assistantReplacement(event, operation.blockIndex, operation.text),
    },
    queuedUsers: operation.cascade === 'preserve'
      ? downstreamUsers(turns, turnIndex + 1)
      : [],
  }
}

function retryPlan(
  sessionId: string,
  turnNumber: number,
  cascade: CascadePolicy,
  turns: readonly ClosedTurn[],
): OperationPlan {
  const turnIndex = turns.findIndex(turn => turn.turn === turnNumber)
  const turn = turns[turnIndex]
  if (turn?.user === undefined) throw new Error('所选回合没有可重放的用户输入。')
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(sessionId, {
      operation: 'retry',
      cascade,
      targetTurn: turn.turn,
      targetEventSeq: turn.user.seq,
    }),
    queuedUsers: cascade === 'preserve'
      ? downstreamUsers(turns, turnIndex)
      : [cloneUser(turn.user.data)],
  }
}

function rerollPlan(sessionId: string, turns: readonly ClosedTurn[]): OperationPlan {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn?.user === undefined) continue
    const target = turn.assistants.findLast(event => event.data.message.content.some(isTextualBlock))
    if (target === undefined) continue
    return {
      boundary: turn.startSeq - 1,
      version: pairVersionEffect(sessionId, {
        operation: 'reroll',
        cascade: 'truncate',
        targetTurn: turn.turn,
        targetEventSeq: target.seq,
      }),
      queuedUsers: [cloneUser(turn.user.data)],
    }
  }
  throw new Error('当前会话没有可重生成的已落定助手回复。')
}

function planOperation(operation: Exclude<MessageEditOperation, SaveOperation>, events: readonly SessionEvent[], editedUserContent?: readonly ContentBlock[]): OperationPlan {
  const turns = closedTurns(events)
  switch (operation.action) {
    case 'edit':
      return editPlan(operation, turns, editedUserContent)
    case 'reroll':
      return rerollPlan(operation.sessionId, turns)
    case 'retry':
      return retryPlan(operation.sessionId, operation.turn, operation.cascade, turns)
  }
}

function agentOptions(events: readonly SessionEvent[], fallback?: AgentOptions): AgentOptions {
  const config = events.findLast(event => event.type === 'request/header')?.data.header.config
  const selected = lastModelSelection(events)
  const provider = selected?.provider ?? fallback?.provider
  const model = selected?.model ?? fallback?.model
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    throw new Error('无法从会话历史解析模型路由。')
  }
  const maxTokens = config?.maxTokens ?? fallback?.maxTokens
  const reasoningEffort = selected === undefined ? fallback?.reasoningEffort
    : selected.reasoningEffort as AgentOptions['reasoningEffort']
  return {
    provider,
    model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

async function withSourceAgent<T>(
  ctx: Context,
  sessionId: SessionId,
  operation: (agent: Agent) => Promise<T>,
): Promise<T> {
  let handle: AgentHandle | undefined
  let agent = ctx.agents.get(sessionId)
  if (agent === undefined) {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptions(snapshot.events),
      ...await presetComposition(ctx, snapshot.session, snapshot.events),
    })
    agent = handle.agent
  }
  try {
    return await agent.runMaintenance(async () => operation(agent))
  } finally {
    await handle?.dispose()
  }
}

function inheritedSeed(source: readonly SessionEvent[], boundary: number): SessionEvent[] {
  if (boundary === -1) return []
  const boundaryEvent = source[boundary]
  if (boundary < 0 || boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
    throw new Error('分支边界不是连续会话事件。')
  }
  return source.slice(0, boundary + 1)
}

/** Build seed envelopes locally; Session construction performs canonical validation and freezing. */
function appendLogSeedEvent<T extends Exclude<SessionEventType, SurfaceEventType>>(
  events: SessionEvent[],
  type: T,
  data: SessionEvent<T>['data'],
): void {
  events.push({
    type, seq: events.length as SessionSeq, time: Date.now(), data,
    ...type === 'message-edit/version' ? { ignorable: true as const } : {},
  } as unknown as SessionEvent<T>)
}

function appendSurfaceSeedEvent<T extends SurfaceEventType>(
  events: SessionEvent[],
  type: T,
  data: SessionEvent<T>['data'],
  intent: SurfaceIntent,
): void {
  events.push({
    type,
    seq: events.length as SessionSeq,
    time: Date.now(),
    data,
    surfaceOp: intent.surfaceOp,
    ...intent.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: intent.sourceEventSeqs },
  } as unknown as SessionEvent<T>)
}

function appendManualTurn(events: SessionEvent[], manual: ManualAssistantTurn): void {
  const { turn, user, assistant } = manual
  appendLogSeedEvent(events, 'turn/start', { turn })
  appendSurfaceSeedEvent(events, 'user/message', user, { surfaceOp: 'append' })
  appendLogSeedEvent(events, 'step/start', { turn, step: 1 })
  appendSurfaceSeedEvent(events, 'assistant/message', { turn, step: 1, message: assistant, stream: [] }, {
    surfaceOp: 'append',
  })
  appendLogSeedEvent(events, 'step/end', { turn, step: 1 })
  appendLogSeedEvent(events, 'turn/end', { turn, reason: { kind: 'completed' } })
}

function versionSeed(source: readonly SessionEvent[], plan: OperationPlan, projections: readonly SessionMessageProjection[]): {
  events: SessionEvent[]
  inheritedLength: number
} {
  const events = inheritedSeed(source, plan.boundary)
  const inheritedLength = events.length
  const saved = savedUserMessages(source)
  const inheritedSaved = savedUserMessages(events)
  const nodes = saved.size === 0 ? [] : foldSurface(events, projections).nodes
  appendLogSeedEvent(events, 'session/end-seed', { inherited: true })
  // 保存可能发生在分支切点之后，继承原日志后再补入保留消息的最新文本。
  for (const [originalSeq, latest] of saved) {
    const original = events[originalSeq]
    if (originalSeq >= inheritedLength || original?.type !== 'user/message') continue
    const current = inheritedSaved.get(originalSeq) ?? original
    if (latest.seq === current.seq || !nodes.includes(current.seq)) continue
    appendSurfaceSeedEvent(events, 'user/message', latest.data, {
      surfaceOp: { op: 'replace', startSeq: current.seq, endSeq: current.seq },
      sourceEventSeqs: [current.seq],
    })
  }
  // 分支切点可能保留尚未消费的原输入，必须清空后再排入编辑后的输入。
  const pending = { 'next-turn': 0, 'next-step': 0 }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    pending[event.data.target] += event.data.inserted.length - (event.data.removedCount ?? 0)
  }
  for (const target of ['next-step', 'next-turn'] as const) {
    if (pending[target] === 0) continue
    appendLogSeedEvent(events, 'agent/inbox/spliced', {
      target, start: 0, removedCount: pending[target], inserted: [], outcome: 'canceled',
    })
  }
  appendLogSeedEvent(events, 'message-edit/version', plan.version)
  if (plan.manualTurn !== undefined) appendManualTurn(events, plan.manualTurn)
  return { events, inheritedLength }
}

function sessionPreset(header: Session['header'], events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return header.agentPreset
}

async function presetComposition(
  ctx: Context,
  header: Session['header'],
  events: readonly SessionEvent[] = [],
): Promise<{ agentPreset?: string; setup?: AgentSetup }> {
  const presets = ctx.get('agentPresets')
  const presetId = sessionPreset(header, events)
  if (presets === undefined) {
    if (presetId !== undefined) throw new Error('会话所用的 Agent preset 服务不可用。')
    return {}
  }
  const resolved = (await presets.resolve(presetId)).id
  return {
    agentPreset: resolved,
    setup: async (agentCtx) => { await presets.mount(agentCtx, resolved) },
  }
}

async function createVersionAgent(
  ctx: Context,
  source: Session,
  sourceEvents: readonly SessionEvent[],
  childId: SessionId,
  plan: OperationPlan,
  options: AgentOptions,
  settings?: MessageEditSettings,
): Promise<AgentHandle> {
  const seed = versionSeed(sourceEvents, plan, ctx.sessions.messageProjections)
  const { agentPreset, setup } = await presetComposition(ctx, source.header, sourceEvents)
  const child = await ctx.agents.create({
    sessionId: childId,
    seed: seed.events,
    inheritedEventCount: seed.inheritedLength as SessionLogOffset,
    meta: {
      ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
      parentSession: source.id,
      isSeeded: true,
      ...agentPreset === undefined ? {} : { agentPreset },
    },
    agentOptions: options,
    ...setup === undefined ? {} : { setup },
  })
  try {
    await applySettings(ctx, child.agent, settings)
    await ctx.sessions.flush(child.agent.session)
    return child
  } catch (error: unknown) {
    await child.dispose()
    throw error
  }
}

function sourceWorkspace(ctx: Context, sessionId: SessionId): Workspace | undefined {
  return ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(sessionId))
}

type OperationInverse = () => void | Promise<void>

interface PermissionPresets {
  current(session: Session): string
  catalog(): { options: readonly { value: string; name: string; description?: string }[]; defaultPreset: string }
  resolve(name: string): unknown
  set(session: Session, name: string): void
}

function sessionController(ctx: Context): SessionController {
  const controller = ctx.get('sessionController') as SessionController | undefined
  if (controller === undefined) throw new Error('当前 DSH 未提供公开会话控制接口。')
  return controller
}

function permissions(ctx: Context): PermissionPresets | undefined {
  return ctx.get('permissionPresets') as PermissionPresets | undefined
}

function lastModelSelection(events: readonly SessionEvent[]): ModelSelection | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'model/selection') return event.data
    if (event?.type === 'request/header') {
      const config = event.data.header.config
      if (config.provider === undefined || config.model === undefined) continue
      return { provider: config.provider, model: config.model,
        ...config.reasoningEffort === undefined || event.data.header.adapterDefaults?.reasoningEffort === true
          ? {} : { reasoningEffort: config.reasoningEffort } }
    }
  }
  return undefined
}

function lastPermissionPreset(events: readonly SessionEvent[]): string | undefined {
  for (const entry of [...events].reverse()) {
    const event = entry as unknown as { type: string; data: { preset?: unknown } }
    if (event.type === 'permission/preset' && typeof event.data.preset === 'string') return event.data.preset
  }
  return undefined
}

async function composerOptions(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<MessageEditComposerOptions> {
  const controller = sessionController(ctx)
  const [snapshot, catalog, projected] = await Promise.all([
    ctx.sessionQuery.readSession(sessionId), controller.modelCatalog(), controller.projections({ sessionId }, signal),
  ])
  const permission = permissions(ctx)
  const permissionCatalog = permission?.catalog()
  const selected = projected?.values.modelSelection?.next ?? lastModelSelection(snapshot.events) ?? catalog.default
  const permissionValue = projected?.values['permissions']
  const currentPreset = typeof permissionValue === 'object' && permissionValue !== null && !Array.isArray(permissionValue)
    && typeof permissionValue['currentValue'] === 'string' ? permissionValue['currentValue']
    : lastPermissionPreset(snapshot.events) ?? permissionCatalog?.defaultPreset
  return {
    current: { ...selected, ...currentPreset === undefined ? {} : { permissionPreset: currentPreset } },
    models: catalog.groups.flatMap(group => group.models.map(model => ({
      provider: group.id, providerLabel: group.name, model: model.id, label: model.name,
      reasoningEfforts: model.reasoning?.efforts.map(effort => effort.id) ?? [],
      ...model.reasoning === undefined ? {} : { reasoningEffortLabels: Object.fromEntries(model.reasoning.efforts.map(effort => [effort.id, effort.name])) },
    }))),
    permissions: permissionCatalog?.options.map(option => ({
      id: option.value, label: option.name, ...option.description === undefined ? {} : { description: option.description },
    })) ?? [],
  }
}

/** 校验配置草稿时只读目录，附件准入或正文校验失败不会修改会话设置。 */
async function validateSettings(ctx: Context, settings: MessageEditSettings | undefined): Promise<void> {
  if (settings === undefined) return
  if (settings.provider !== undefined && settings.model !== undefined) {
    const catalog = await sessionController(ctx).modelCatalog()
    const model = catalog.groups.find(group => group.id === settings.provider)?.models.find(model => model.id === settings.model)
    if (model === undefined) throw new TypeError('所选模型当前不可用。')
    if (settings.reasoningEffort !== undefined && !model.reasoning?.efforts.some(effort => effort.id === settings.reasoningEffort)) {
      throw new TypeError('所选模型不支持该推理强度。')
    }
  }
  if (settings.permissionPreset !== undefined) {
    const permission = permissions(ctx)
    if (permission === undefined) throw new Error('当前 DSH 未提供权限预设。')
    if (!permission.catalog().options.some(option => option.value === settings.permissionPreset)) {
      throw new TypeError('所选权限预设当前不可用。')
    }
    permission.resolve(settings.permissionPreset)
  }
}

/** 只在确认操作后调用与正常输入框一致的公开切换路径。 */
async function applySettings(ctx: Context, agent: Agent, settings: MessageEditSettings | undefined): Promise<void> {
  if (settings === undefined) return
  if (settings.provider !== undefined && settings.model !== undefined) {
    await sessionController(ctx).selectModel({ sessionId: agent.id, provider: settings.provider, model: settings.model,
      ...settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort } })
  }
  if (settings.permissionPreset !== undefined) permissions(ctx)?.set(agent.session, settings.permissionPreset)
}

/** 模型选择省略推理强度表示恢复模型默认值；权限省略则保留原值。 */
async function changedSettings(ctx: Context, sessionId: SessionId, settings: MessageEditSettings | undefined): Promise<MessageEditSettings | undefined> {
  if (settings === undefined || Object.keys(settings).length === 0) return undefined
  const current = (await composerOptions(ctx, sessionId, new AbortController().signal)).current
  const changed: MessageEditSettings = {}
  if (settings.provider !== undefined && settings.model !== undefined && (settings.provider !== current.provider || settings.model !== current.model
    || settings.reasoningEffort !== current.reasoningEffort)) {
    changed.provider = settings.provider
    changed.model = settings.model
    if (settings.reasoningEffort !== undefined) changed.reasoningEffort = settings.reasoningEffort
  }
  if (settings.permissionPreset !== undefined && settings.permissionPreset !== current.permissionPreset) {
    changed.permissionPreset = settings.permissionPreset
  }
  return Object.keys(changed).length === 0 ? undefined : changed
}

async function liveAgent(ctx: Context, sessionId: SessionId): Promise<Agent> {
  const existing = ctx.agents.get(sessionId)
  if (existing !== undefined) return existing
  const result = await sessionController(ctx).resolveAgent(sessionId)
  if ('error' in result) throw result.error
  return result.agent
}

async function references(ctx: Context, sessionId: SessionId, query: string, signal: AbortSignal): Promise<MessageEditReference[]> {
  const service = ctx.get('fileReferences') as FileReferenceService | undefined
  if (service === undefined) return []
  return (await service.list(await liveAgent(ctx, sessionId), query, signal)).map(candidate => ({
    path: candidate.path, label: candidate.path, kind: candidate.kind === 'directory' ? 'folder' : 'file',
  }))
}

async function openAttachment(ctx: Context, sessionId: SessionId, eventSeq: number, blockIndex: number, signal: AbortSignal): Promise<void> {
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  const original = snapshot.events.find(event => event.seq === eventSeq)
  if (original?.type !== 'user/message') throw new TypeError('所选消息不存在。')
  const current = savedUserMessages(snapshot.events).get(original.seq) ?? original
  const block = current.data.content[blockIndex]
  if (block?.type !== 'file') throw new TypeError('所选附件不是当前消息中的文件。')
  const store = ctx.get('attachments') as AttachmentStore | undefined
  const path = store?.fileHostPath(block.attachment)
  if (path === undefined) throw new Error('当前附件存储不支持在系统应用中打开文件。')
  await sessionController(ctx).openWorkspacePath({ path }, signal)
}

async function openUpload(ctx: Context, sessionId: SessionId, receiptId: string, signal: AbortSignal): Promise<void> {
  const agent = await liveAgent(ctx, sessionId)
  const uploads = ctx.get('fileUploads') as FileUploads | undefined
  if (uploads === undefined) throw new Error('当前 DSH 未提供文件上传服务。')
  const attachment = uploads.resolve(agent, receiptId as FileUploadReceiptId)
  if (attachment === undefined) throw new TypeError('文件上传凭据不属于当前会话或已失效。')
  const store = ctx.get('attachments') as AttachmentStore | undefined
  const path = store?.fileHostPath(attachment)
  if (path === undefined) throw new Error('当前附件存储不支持在系统应用中打开文件。')
  await sessionController(ctx).openWorkspacePath({ path }, signal)
}

async function openReference(ctx: Context, sessionId: SessionId, path: string, signal: AbortSignal): Promise<void> {
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  const fs = ctx.get('fs') as FileSystem | undefined
  if (fs === undefined) throw new Error('当前 DSH 未提供文件系统服务。')
  // 相对引用从所属会话工作区解析；绝对路径沿用桌面端的原生验证和打开能力。
  const target = await fs.resolve(path, { ...snapshot.session.cwd === undefined ? {} : { cwd: snapshot.session.cwd }, signal })
  await sessionController(ctx).openWorkspacePath({ path: fs.processPath(target) }, signal)
}

async function recoverOperation(inverses: OperationInverse[]): Promise<void> {
  const failures: unknown[] = []
  for (const inverse of inverses.reverse()) {
    try {
      await inverse()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, '版本操作恢复失败。')
}

async function runOperation(ctx: Context, operation: MessageEditOperation): Promise<MessageEditOperationResult> {
  const sourceId = sessionIdOf(operation.sessionId)
  if (operation.action === 'save' || (operation.action === 'edit' && operation.regenerate === false)) {
    return saveUserMessage(ctx, sourceId, operation)
  }
  // 冷会话恢复可能写入宿主初始化事件，助手未改内容时直接只读确认。
  if (operation.action === 'edit' && operation.settings === undefined && operation.attachments === undefined
    && ctx.agents.get(sourceId) === undefined) {
    const { events } = await ctx.sessionQuery.readSession(sourceId)
    const plan = planOperation(operation, visibleUserEvents(events))
    if (plan.manualTurn !== undefined && plan.version.effect.before === plan.version.effect.after) {
      return { sessionId: sourceId, queuedTurns: 0, unchanged: true }
    }
  }
  return withSourceAgent(ctx, sourceId, async (source) => {
    const events = (await ctx.sessionQuery.readSession(sourceId)).events
    const visible = visibleUserEvents(events)
    const settings = operation.action === 'edit' ? operation.settings : undefined
    if (operation.action === 'edit' && settings !== undefined && !closedTurns(visible).some(turn => turn.user?.seq === operation.eventSeq)) {
      throw new TypeError('只有用户消息可以设置模型和权限。')
    }
    await validateSettings(ctx, settings)
    const perform = async (editedUserContent?: readonly ContentBlock[]): Promise<MessageEditOperationResult> => {
      const childId = sessionIdOf(`session-${crypto.randomUUID()}`)
      const inverses: OperationInverse[] = []
      try {
        const plan = planOperation(operation, visible, editedUserContent)
        // 用户主动重生成不受此守卫影响；助手原文保存不应制造新版本。
        if (plan.manualTurn !== undefined && plan.version.effect.before === plan.version.effect.after) {
          return { sessionId: sourceId, queuedTurns: 0, unchanged: true }
        }
        const options = agentOptions(events, source.options)
        const child = await createVersionAgent(ctx, source.session, events, childId, plan, options, settings)
        inverses.push(() => child.dispose())

        const workspace = sourceWorkspace(ctx, sourceId)
        if (workspace !== undefined) {
          await workspace.attachSession(childId)
          inverses.push(() => workspace.detachSession(childId))
        }
        for (const message of plan.queuedUsers) child.agent.followup(message)

        inverses.length = 0
        return { sessionId: childId, queuedTurns: plan.queuedUsers.length }
      } catch (error: unknown) {
        try {
          await recoverOperation(inverses)
        } catch (recoveryError: unknown) {
          throw new AggregateError([error, recoveryError], '版本操作及其恢复均失败。')
        }
        throw error
      }
    }
    if (operation.action === 'edit') {
      const user = closedTurns(visible).find(turn => turn.user?.seq === operation.eventSeq)?.user
      if (user !== undefined) return withEditedUserContent(ctx, source, user.data, operation, perform)
      if (operation.attachments !== undefined) {
        throw new TypeError('只有用户消息可以编辑附件。')
      }
    }
    return perform()
  })
}

async function saveUserMessage(
  ctx: Context,
  sourceId: SessionId,
  operation: SaveOperation | EditOperation,
): Promise<MessageEditOperationResult> {
  // 无修改的冷会话不需要恢复 Agent；只读比较可避免宿主初始化落盘。
  if (ctx.agents.get(sourceId) === undefined) {
    const { events } = await ctx.sessionQuery.readSession(sourceId)
    const original = closedTurns(events).find(turn => turn.user?.seq === operation.eventSeq)?.user
    if (original !== undefined) {
      const current = savedUserMessages(events).get(original.seq) ?? original
      let content: readonly ContentBlock[] | undefined = replaceUserText(current.data.content, operation.blockIndex, operation.text)
      if (operation.attachments !== undefined) {
        const retained: MessageEditAttachmentBlock[] = []
        for (const input of operation.attachments) {
          if (input.type !== 'retained') { content = undefined; break }
          const block = current.data.content[input.blockIndex]
          if (!isAttachmentBlock(block)) throw new TypeError('保留的附件位置不存在或不是附件。')
          retained.push(block)
        }
        if (content !== undefined) content = replaceUserAttachments(content, retained)
      }
      if (content !== undefined && equalContentValue(content, current.data.content)
        && foldSurface(events, ctx.sessions.messageProjections).nodes.includes(current.seq)) {
        await validateSettings(ctx, operation.settings)
        if (await changedSettings(ctx, sourceId, operation.settings) === undefined) {
          return { sessionId: sourceId, queuedTurns: 0, saved: true, unchanged: true }
        }
      }
    }
  }
  return withSourceAgent(ctx, sourceId, async source => {
    const events = (await ctx.sessionQuery.readSession(sourceId)).events
    const turn = closedTurns(events).find(candidate => candidate.user?.seq === operation.eventSeq)
    const original = turn?.user
    if (original === undefined) throw new Error('所选用户消息不存在或回合尚未结束。')
    const current = savedUserMessages(events).get(original.seq) ?? original
    if (!source.session.surface.nodes.includes(current.seq)) {
      throw new Error('该消息已不在当前模型上下文中，无法在当前会话保存；可以使用“保存并发送”创建新版本。')
    }
    return withEditedUserContent(ctx, source, current.data, operation, async content => {
      await validateSettings(ctx, operation.settings)
      const settings = await changedSettings(ctx, sourceId, operation.settings)
      const contentChanged = !equalContentValue(content, current.data.content)
      if (!contentChanged && settings === undefined) {
        return { sessionId: sourceId, queuedTurns: 0, saved: true, unchanged: true }
      }
      await applySettings(ctx, source, settings)
      const messageSource: UserMessage['source'] & SavedUserMessageSource = {
        ...current.data.source, messageEdit: { originalEventSeq: original.seq },
      }
      if (contentChanged) {
        source.session.append('user/message', { ...current.data, content, source: messageSource }, {
          surfaceOp: { op: 'replace', startSeq: current.seq, endSeq: current.seq },
          sourceEventSeqs: [current.seq],
        })
      }
      await ctx.sessions.flush(source.session)
      return { sessionId: sourceId, queuedTurns: 0, saved: true }
    })
  })
}

function ownVersionEvent(
  header: SessionRecord['header'],
  events: readonly SessionEvent[],
  inherited: number,
): VersionProjection | undefined {
  const ownEvents = events.filter((event): event is SessionEvent<'message-edit/version'> => (
    event.type === 'message-edit/version' && event.seq >= inherited
  ))
  if (ownEvents.length === 0) return undefined
  if (ownEvents.length > 1) {
    throw new Error(`会话 ${header.id} 包含多个自身版本效果。`)
  }
  const event = ownEvents[0]
  if (event === undefined) return undefined
  const parent = header.parentSession
  if ('schemaVersion' in event.data) {
    const version = event.data
    if (version.schemaVersion !== MESSAGE_EDIT_VERSION_SCHEMA) {
      throw new Error(`会话 ${header.id} 使用不支持的版本效果结构。`)
    }
    if (version.inverse.kind !== 'restore-version'
      || parent === undefined
      || version.inverse.sessionId !== parent) {
      throw new Error(`会话 ${header.id} 的版本效果与逆不匹配。`)
    }
    return { effect: version.effect, inverseSessionId: version.inverse.sessionId, time: event.time }
  }

  const legacy: LegacyMessageEditVersionEvent = event.data
  if (parent === undefined || legacy.sourceSessionId !== parent) {
    throw new Error(`会话 ${header.id} 的旧版恢复目标与父版本不匹配。`)
  }
  return {
    effect: {
      id: `legacy:${header.id}:${String(event.seq)}`,
      operation: legacy.operation,
      cascade: legacy.cascade,
      targetTurn: legacy.targetTurn,
      targetEventSeq: legacy.targetEventSeq,
      ...legacy.targetBlockIndex === undefined ? {} : { targetBlockIndex: legacy.targetBlockIndex },
      ...legacy.blockKind === undefined ? {} : { blockKind: legacy.blockKind },
      ...legacy.before === undefined ? {} : { before: legacy.before },
      ...legacy.after === undefined ? {} : { after: legacy.after },
    },
    inverseSessionId: legacy.sourceSessionId,
    time: event.time,
  }
}

function flattenLineage(
  root: SessionRecord,
  descendants: readonly SessionLineageNode[],
): Array<{ record: SessionRecord; depth: number }> {
  const result: Array<{ record: SessionRecord; depth: number }> = [{ record: root, depth: 0 }]
  const visit = (nodes: readonly SessionLineageNode[], depth: number): void => {
    const ordered = [...nodes].sort((left, right) => (
      left.session.header.createdAt - right.session.header.createdAt
      || String(left.session.header.id).localeCompare(String(right.session.header.id))
    ))
    for (const node of ordered) {
      result.push({ record: node.session, depth })
      visit(node.descendants, depth + 1)
    }
  }
  visit(descendants, 1)
  return result
}

/** Bounded parallel inspection of persisted branches; matches the corpus worker shape. */
const TIMELINE_READ_CONCURRENCY = 4

async function mapConcurrent<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T)
    }
  }
  const workers = Math.min(TIMELINE_READ_CONCURRENCY, items.length)
  await Promise.all(Array.from({ length: workers }, () => run()))
  return results
}

async function timeline(ctx: Context, sessionId: SessionId): Promise<MessageEditTimeline> {
  const targetTrace = await ctx.sessionQuery.traceSession(sessionId)
  const rootId = targetTrace.complete
    ? targetTrace.root.header.id
    : targetTrace.ancestors.at(-1)?.header.id ?? sessionId
  const rootTrace = rootId === sessionId ? targetTrace : await ctx.sessionQuery.traceSession(rootId)
  const lineage = flattenLineage(rootTrace.target, rootTrace.descendants)
  const logs = await mapConcurrent(lineage, async ({ record }) => {
    if (record.header.id !== sessionId && record.header.parentSession === undefined) {
      return { events: [] as SessionEvent[], inheritedEventCount: 0 }
    }
    return ctx.sessionQuery.readSession(record.header.id)
  })
  const recordsById = new Map(lineage.map(({ record }) => [record.header.id, record]))
  const currentPath = new Set<SessionId>()
  let pathId: SessionId | undefined = sessionId
  while (pathId !== undefined && !currentPath.has(pathId)) {
    currentPath.add(pathId)
    pathId = recordsById.get(pathId)?.header.parentSession
  }

  const versions: VersionSummary[] = lineage.map(({ record, depth }, index) => {
    const log = logs[index]
    const version = ownVersionEvent(record.header, log?.events ?? [], log?.inheritedEventCount ?? 0)
    return {
      sessionId: record.header.id,
      ...record.header.parentSession === undefined ? {} : { parentSessionId: record.header.parentSession },
      ...version === undefined ? {} : {
        effectId: version.effect.id,
        inverseSessionId: version.inverseSessionId,
      },
      createdAt: version?.time ?? record.header.createdAt,
      depth,
      current: record.header.id === sessionId,
      onCurrentEffectPath: currentPath.has(record.header.id),
      ...version === undefined ? {} : {
        operation: version.effect.operation,
        cascade: version.effect.cascade,
        targetTurn: version.effect.targetTurn,
        ...version.effect.blockKind === undefined ? {} : { blockKind: version.effect.blockKind },
        ...version.effect.before === undefined ? {} : { before: version.effect.before },
        ...version.effect.after === undefined ? {} : { after: version.effect.after },
      },
    }
  })
  const effectIds = new Set<string>()
  for (const version of versions) {
    if (version.effectId === undefined) continue
    if (effectIds.has(version.effectId)) throw new Error(`版本效果 ${version.effectId} 重复。`)
    effectIds.add(version.effectId)
  }

  const versionsById = new Map(versions.map(version => [version.sessionId, version]))
  const undoStack: string[] = []
  let undoCursor = versionsById.get(sessionId)
  while (undoCursor?.inverseSessionId !== undefined) {
    const inverseId = undoCursor.inverseSessionId
    if (undoStack.includes(inverseId)) throw new Error('版本效果逆链包含循环。')
    if (!versionsById.has(inverseId)) throw new Error(`恢复目标 ${inverseId} 不在可见版本树中。`)
    undoStack.push(inverseId)
    undoCursor = versionsById.get(inverseId)
  }
  const redoSessionIds = versions
    .filter(version => version.inverseSessionId === sessionId)
    .map(version => version.sessionId)

  const currentIndex = versions.findIndex(version => version.current)
  const currentLog = logs[currentIndex]
  if (currentIndex < 0 || currentLog === undefined) throw new Error('当前版本不在版本树中。')
  const turns = closedTurns(visibleUserEvents(currentLog.events))
  return {
    sessionId,
    build: MESSAGE_EDIT_BUILD_INFO,
    messages: editableMessages(turns),
    retryableTurns: retryableTurns(turns),
    versions,
    undoStack,
    redoSessionIds,
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('请求体必须是 JSON 对象。')
  }
  return value as Record<string, unknown>
}

function sessionIdOf(value: unknown): SessionId {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('sessionId 必须是非空字符串。')
  return value as SessionId
}

function integerOf(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} 必须是非负安全整数。`)
  }
  return value as number
}

function cascadeOf(value: unknown): CascadePolicy {
  if (value !== 'truncate' && value !== 'preserve') throw new TypeError('cascade 必须是 truncate 或 preserve。')
  return value
}

function attachmentsOf(value: unknown): readonly MessageEditAttachmentInput[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError('attachments 必须是数组。')
  return value.map((input): MessageEditAttachmentInput => {
    const attachment = objectValue(input)
    switch (attachment['type']) {
      case 'retained':
        return { type: 'retained', blockIndex: integerOf(attachment['blockIndex'], '附件 blockIndex') }
      case 'file':
        if (typeof attachment['receiptId'] !== 'string' || attachment['receiptId'].length === 0) {
          throw new TypeError('文件附件需要有效的 receiptId。')
        }
        return { type: 'file', receiptId: attachment['receiptId'] }
      case 'image': {
        const mediaType = attachment['mediaType']
        if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif') {
          throw new TypeError('图片格式必须是 PNG、JPEG、WebP 或 GIF。')
        }
        if (typeof attachment['data'] !== 'string' || attachment['data'].length === 0) {
          throw new TypeError('图片附件需要上传字节，不能直接提交持久引用。')
        }
        if (attachment['name'] !== undefined && typeof attachment['name'] !== 'string') {
          throw new TypeError('附件 name 必须是字符串。')
        }
        return { type: 'image', mediaType, data: attachment['data'],
          ...attachment['name'] === undefined ? {} : { name: attachment['name'] as string } }
      }
      default:
        throw new TypeError('附件必须是已有附件位置、图片上传或文件上传凭据。')
    }
  })
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${name} 必须是非空字符串。`)
  return value
}

function settingsOf(value: unknown): MessageEditSettings | undefined {
  if (value === undefined) return undefined
  const settings = objectValue(value)
  const provider = settings['provider'] === undefined ? undefined : nonEmptyString(settings['provider'], 'provider')
  const model = settings['model'] === undefined ? undefined : nonEmptyString(settings['model'], 'model')
  if ((provider === undefined) !== (model === undefined)) throw new TypeError('provider 和 model 必须同时提供。')
  const effort = settings['reasoningEffort'] === undefined ? undefined : nonEmptyString(settings['reasoningEffort'], 'reasoningEffort')
  if (effort !== undefined && model === undefined) throw new TypeError('推理强度必须与模型一起提供。')
  return {
    ...provider === undefined ? {} : { provider }, ...model === undefined ? {} : { model },
    ...effort === undefined ? {} : { reasoningEffort: effort },
    ...settings['permissionPreset'] === undefined ? {} : { permissionPreset: nonEmptyString(settings['permissionPreset'], 'permissionPreset') },
  }
}

function decodeOperation(value: unknown): MessageEditOperation {
  const record = objectValue(value)
  const sessionId = sessionIdOf(record['sessionId'])
  const attachments = attachmentsOf(record['attachments'])
  const settings = settingsOf(record['settings'])
  switch (record['action']) {
    case 'save':
      if (typeof record['text'] !== 'string') throw new TypeError('text 必须是字符串。')
      return {
        action: 'save', sessionId,
        eventSeq: integerOf(record['eventSeq'], 'eventSeq'),
        blockIndex: integerOf(record['blockIndex'], 'blockIndex'),
        text: record['text'],
        ...attachments === undefined ? {} : { attachments },
        ...settings === undefined ? {} : { settings },
      }
    case 'edit':
      if (typeof record['text'] !== 'string') throw new TypeError('text 必须是字符串。')
      if (record['regenerate'] !== undefined && typeof record['regenerate'] !== 'boolean') {
        throw new TypeError('regenerate 必须是布尔值。')
      }
      return {
        action: 'edit',
        sessionId,
        eventSeq: integerOf(record['eventSeq'], 'eventSeq'),
        blockIndex: integerOf(record['blockIndex'], 'blockIndex'),
        text: record['text'],
        cascade: cascadeOf(record['cascade']),
        ...record['regenerate'] === undefined ? {} : { regenerate: record['regenerate'] as boolean },
        ...attachments === undefined ? {} : { attachments },
        ...settings === undefined ? {} : { settings },
      }
    case 'reroll':
      return { action: 'reroll', sessionId }
    case 'retry':
      return {
        action: 'retry',
        sessionId,
        turn: integerOf(record['turn'], 'turn'),
        cascade: cascadeOf(record['cascade']),
      }
    default:
      throw new TypeError('action 必须是 save、edit、reroll 或 retry。')
  }
}

function respondJson(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** 提供节点身份及完整替换窗口，不返回正文，供其他插件解析修订链。 */
async function revisions(ctx: Context, sessionId: SessionId): Promise<{
  schemaVersion: 1
  sessionId: string
  revisions: MessageEditRevision[]
  replacements: { replacementEventSeq: number; startSeq: number; endSeq: number; shadowedEventSeqs: number[] }[]
}> {
  const { events } = await ctx.sessionQuery.readSession(sessionId)
  const saved = savedUserMessages(events)
  const surface = foldSurface(events, ctx.sessions.messageProjections)
  return {
    schemaVersion: 1, sessionId,
    revisions: [...saved.entries()].map(([originalEventSeq, replacement]) => ({
      originalEventSeq, replacementEventSeq: replacement.seq,
      revisionEventSeqs: events.filter(event => savedUserMessageSeq(event) === originalEventSeq).map(event => event.seq),
      active: surface.nodes.includes(replacement.seq),
    })),
    replacements: surface.replacements.map(entry => ({
      replacementEventSeq: entry.seq, startSeq: entry.start, endSeq: entry.end, shadowedEventSeqs: entry.shadowedSeqs,
    })),
  }
}

interface DiagnosticEntry {
  time: number
  action: string
  status: number
  unchanged?: boolean
  code?: 'invalid-request' | 'operation-failed'
}

async function handleRoute(ctx: Context, request: Request, recent: DiagnosticEntry[]): Promise<Response> {
  let action = 'unknown'
  try {
    if (request.method === 'GET') {
      const query = new URL(request.url).searchParams
      if (query.get('view') === 'diagnostics') return respondJson(200, {
        schemaVersion: 1, build: MESSAGE_EDIT_BUILD_INFO, recent: [...recent],
      })
      const sessionId = sessionIdOf(query.get('sessionId'))
      if (query.get('view') === 'revisions') return respondJson(200, await revisions(ctx, sessionId))
      if (query.get('view') === 'options') return respondJson(200, await composerOptions(ctx, sessionId, request.signal))
      if (query.get('view') === 'references') return respondJson(200, await references(ctx, sessionId, query.get('query') ?? '', request.signal))
      return respondJson(200, await timeline(ctx, sessionId))
    }
    if (request.method === 'POST') {
      let value: unknown
      try {
        value = await request.json()
      } catch {
        throw new TypeError('请求体必须是有效的 JSON。')
      }
      const record = objectValue(value)
      if (['save', 'edit', 'reroll', 'retry', 'open-attachment', 'open-upload', 'open-reference'].includes(String(record['action']))) {
        action = String(record['action'])
      }
      const sessionId = sessionIdOf(record['sessionId'])
      if (record['action'] === 'open-attachment') {
        await openAttachment(ctx, sessionId, integerOf(record['eventSeq'], 'eventSeq'), integerOf(record['blockIndex'], 'blockIndex'), request.signal)
        return respondJson(200, { opened: true })
      }
      if (record['action'] === 'open-upload') {
        await openUpload(ctx, sessionId, nonEmptyString(record['receiptId'], 'receiptId'), request.signal)
        return respondJson(200, { opened: true })
      }
      if (record['action'] === 'open-reference') {
        await openReference(ctx, sessionId, nonEmptyString(record['path'], 'path'), request.signal)
        return respondJson(200, { opened: true })
      }
      const result = await runOperation(ctx, decodeOperation(value))
      recent.push({ time: Date.now(), action, status: 200, ...result.unchanged === true ? { unchanged: true } : {} })
      if (recent.length > 40) recent.shift()
      return respondJson(200, result)
    }
    return new Response(null, { status: 405 })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const status = error instanceof TypeError ? 400 : 409
    if (request.method === 'POST') {
      recent.push({ time: Date.now(), action, status, code: error instanceof TypeError ? 'invalid-request' : 'operation-failed' })
      if (recent.length > 40) recent.shift()
    }
    return respondJson(status, { error: message })
  }
}

/** 通过宿主通信层注册路由，复用桌面端和浏览器的认证与传输。 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as unknown as HostConnectionHandle
  const recent: DiagnosticEntry[] = []
  connection.fetch.register({
    path: MESSAGE_EDIT_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => handleRoute(ctx, request, recent),
  })
}
