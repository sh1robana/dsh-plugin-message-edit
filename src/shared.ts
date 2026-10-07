import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Same-origin endpoint owned by the Message Edit host plugin. */
export const MESSAGE_EDIT_PATH = '/api/message-edit'

/** Timeline sits between Trajectory (10) and Prompt Studio (20). */
export const MESSAGE_EDIT_VIEW_ORDER = 15

/** Downstream-history policy after a historical turn changes. */
export type CascadePolicy = 'truncate' | 'preserve'

/** User-visible operation represented by one child version. */
export type VersionOperation = 'edit' | 'reroll' | 'retry'

/** Editable model-surface block classification. */
export type EditableBlockKind = 'user' | 'assistant.reasoning' | 'assistant.response'

/** 附件沿用宿主的持久内容块，保留显示名称、尺寸和卸载状态。 */
export type MessageEditAttachmentBlock = Extract<ContentBlock, { type: 'image' | 'file' }>

/** 已有附件通过当前消息中的内容块位置保留，客户端不提交持久引用。 */
export interface EditableMessageAttachment {
  blockIndex: number
  content: MessageEditAttachmentBlock
}

/** 新附件复用官方草稿序列化格式；文件凭据只能在来源 Agent 内解析。 */
export type MessageEditAttachmentInput = {
  type: 'retained'
  blockIndex: number
} | {
  type: 'image'
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
  name?: string
} | {
  type: 'file'
  receiptId: string
}

/** 编辑器中的会话配置草稿，只有确认保存后才应用到目标会话。 */
export interface MessageEditSettings {
  provider?: string
  model?: string
  reasoningEffort?: string
  permissionPreset?: string
}

/** 供编辑器复用正常输入框的模型、推理和权限选项。 */
export interface MessageEditComposerOptions {
  current: MessageEditSettings
  models: readonly {
    provider: string
    providerLabel?: string
    model: string
    label: string
    reasoningEfforts: readonly string[]
    reasoningEffortLabels?: Readonly<Record<string, string>>
  }[]
  permissions: readonly { id: string; label: string; description?: string }[]
}

/** 官方工作区文件候选的编辑器展示格式。 */
export interface MessageEditReference {
  path: string
  label: string
  kind: 'file' | 'folder'
}

/** Current durable event schema for structurally paired version effects. */
export const MESSAGE_EDIT_VERSION_SCHEMA = 2

/** Forward half of one atomic version effect. */
export interface MessageEditEffect {
  id: string
  operation: VersionOperation
  cascade: CascadePolicy
  targetTurn: number
  targetEventSeq: number
  targetBlockIndex?: number
  blockKind?: EditableBlockKind
  before?: string
  after?: string
  /** 用户消息编辑是否重新请求模型；旧版本未记录时沿用原有行为。 */
  regenerate?: boolean
}

/** Inverse half generated together with a version effect. */
export interface MessageEditInverse {
  kind: 'restore-version'
  sessionId: string
}

/** Durable effect/inverse pair appended to each branch created by this plugin. */
export interface MessageEditVersionEvent {
  schemaVersion: typeof MESSAGE_EDIT_VERSION_SCHEMA
  effect: MessageEditEffect
  inverse: MessageEditInverse
}

/** Read compatibility for branches written before structural pairing. */
export interface LegacyMessageEditVersionEvent {
  sourceSessionId: string
  operation: VersionOperation
  cascade: CascadePolicy
  targetTurn: number
  targetEventSeq: number
  targetBlockIndex?: number
  blockKind?: EditableBlockKind
  before?: string
  after?: string
}

/** Every durable event shape accepted by the lineage reader. */
export type StoredMessageEditVersionEvent = MessageEditVersionEvent | LegacyMessageEditVersionEvent

/** One text-bearing block that the Timeline editor can replace. */
export interface EditableMessageBlock {
  key: string
  turn: number
  eventSeq: number
  blockIndex: number
  kind: EditableBlockKind
  text: string
  time: number
  /** 用户消息的最新完整内容，供官方气泡同时投影正文和附件。 */
  content?: readonly ContentBlock[]
  attachments?: readonly EditableMessageAttachment[]
}

/** One completed message-triggered turn eligible for Retry. */
export interface RetryableTurn {
  turn: number
  userEventSeq: number
  preview: string
  time: number
}

/** One session version in the complete known lineage tree. */
export interface VersionSummary {
  sessionId: string
  parentSessionId?: string
  effectId?: string
  inverseSessionId?: string
  createdAt: number
  depth: number
  current: boolean
  onCurrentEffectPath: boolean
  operation?: VersionOperation
  cascade?: CascadePolicy
  targetTurn?: number
  blockKind?: EditableBlockKind
  before?: string
  after?: string
}

/** Complete value-level projection consumed by both Timeline and header controls. */
export interface MessageEditTimeline {
  sessionId: string
  messages: EditableMessageBlock[]
  retryableTurns: RetryableTurn[]
  versions: VersionSummary[]
  /** Atomic inverses from the current version outward, in application order. */
  undoStack: string[]
  /** Direct child effects that can be re-applied from the current version. */
  redoSessionIds: string[]
  /** 实际加载的宿主构建，供客户端识别前后端版本不一致。 */
  build?: MessageEditBuildInfo
}

/** 构建身份不包含会话内容或本机路径。 */
export interface MessageEditBuildInfo {
  version: string
  buildId: string
  targetDshVersion: string
}

/** 原地保存的只读修订链；active 为 false 时禁止拿旧节点直接执行操作。 */
export interface MessageEditRevision {
  originalEventSeq: number
  replacementEventSeq: number
  revisionEventSeqs: number[]
  active: boolean
}

/** Edit one text/reasoning block and regenerate from its turn boundary. */
export interface EditOperation {
  action: 'edit'
  sessionId: string
  eventSeq: number
  blockIndex: number
  text: string
  cascade: CascadePolicy
  /** 用户消息默认重新生成，false 表示保留已有对话且只保存文本。 */
  regenerate?: boolean
  /** 未提供时保留当前附件，空数组移除全部；仅用户消息接受此字段。 */
  attachments?: readonly MessageEditAttachmentInput[]
  settings?: MessageEditSettings
}

/** 在当前会话保存用户文本，不创建分支、不排入模型输入。 */
export interface SaveOperation {
  action: 'save'
  sessionId: string
  eventSeq: number
  blockIndex: number
  text: string
  /** 未提供时保留当前附件，空数组移除全部。 */
  attachments?: readonly MessageEditAttachmentInput[]
  settings?: MessageEditSettings
}

/** Regenerate the latest completed assistant reply. */
export interface RerollOperation {
  action: 'reroll'
  sessionId: string
}

/** Regenerate any selected historical turn. */
export interface RetryOperation {
  action: 'retry'
  sessionId: string
  turn: number
  cascade: CascadePolicy
}

/** Mutation accepted by the host route. */
export type MessageEditOperation = SaveOperation | EditOperation | RerollOperation | RetryOperation

/** 当前会话保存或新版本创建完成后的宿主确认。 */
export interface MessageEditOperationResult {
  sessionId: string
  queuedTurns: number
  /** 仅保存时为 true，且 sessionId 必须仍为来源会话。 */
  saved?: boolean
  /** 内容及设置没有变化，未写事件、未创建分支，也未请求模型。 */
  unchanged?: boolean
}
