import { createElement, useEffect, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageEditFace } from './controller.ts'

const CHAT_NODE_SLOT = 'conversation.chat.node'
const USER_NODE_KEYS = ['user', 'steering'] as const

interface UserNode {
  readonly data: {
    readonly seq: number
    readonly content: readonly ContentBlock[]
  }
}

type UserNodeProps = Record<string, unknown> & { readonly node: UserNode } & InjectFace<MessageEditFace>

interface UserSlotOptions {
  name: typeof CHAT_NODE_SLOT
  key: typeof USER_NODE_KEYS[number]
  priority: number
  locale?: string
  inject(sessionId: SessionId): MessageEditFace
}

/** 通过公开的动态插槽接口接入，避免把整个官方聊天插件打进浏览器包。 */
interface ChatNodeSlots {
  entries(name: string): readonly StoredEntry[]
  subscribe(name: string, listener: () => void): () => void
  register(options: UserSlotOptions, component: ComponentType<UserNodeProps>): () => void
}

function equalContentValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalContentValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  return keys.length === Object.keys(rightRecord).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(rightRecord, key) && equalContentValue(leftRecord[key], rightRecord[key]))
}

function projectedRenderer(original: StoredEntry): ComponentType<UserNodeProps> {
  const Original = original.component as ComponentType<Record<string, unknown>>
  return function UserMessageProjection(props: UserNodeProps): ReactNode {
    const { acquire, load, node, useMessageEdit } = props
    const messages = useMessageEdit(state => state.timeline?.messages)
    useEffect(() => {
      const release = acquire()
      load()
      return release
    }, [acquire, load])

    const savedContent = messages?.find(message => message.kind === 'user'
      && message.eventSeq === node.data.seq && message.content !== undefined)?.content
    let projected = node
    if (savedContent !== undefined) {
      if (!equalContentValue(node.data.content, savedContent)) {
        projected = { ...node, data: { ...node.data, content: savedContent } }
      }
    } else {
      // 兼容未提供完整内容的旧记录，仍按原内容块位置覆盖文本。
      let changed = false
      const content = node.data.content.map((block, blockIndex) => {
        if (block.type !== 'text') return block
        const saved = messages?.find(message => message.kind === 'user'
          && message.eventSeq === node.data.seq && message.blockIndex === blockIndex)
        if (saved === undefined || saved.text === block.text) return block
        changed = true
        return { ...block, text: saved.text }
      })
      if (changed) projected = { ...node, data: { ...node.data, content } }
    }
    return createElement(Original, { ...props, node: projected })
  }
}

/** 覆写用户消息的显示内容，复用官方气泡、附件和复制操作，不修改宿主的只读事件源。 */
export function registerUserMessageProjection(
  ctx: Context,
  faceFor: (sessionId: SessionId) => MessageEditFace,
): void {
  const slots = ctx.slots as unknown as ChatNodeSlots
  // 旧宿主缺少公开的插槽检查接口时，仍保留 Timeline 的编辑入口。
  if (typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') return
  ctx.effect(() => {
    const active = new Map<string, { original: StoredEntry; component: ComponentType<UserNodeProps>; dispose(): void }>()
    let disposed = false
    const sync = (): void => {
      if (disposed) return
      for (const key of USER_NODE_KEYS) {
        const current = active.get(key)
        const original = slots.entries(CHAT_NODE_SLOT).find(entry => entry.options.key === key
          && !Array.from(active.values()).some(wrapper => wrapper.component === entry.component))
        if (current?.original === original) continue
        current?.dispose()
        active.delete(key)
        if (original === undefined) continue
        const component = projectedRenderer(original)
        const dispose = slots.register({
          name: CHAT_NODE_SLOT,
          key,
          priority: (original.options.priority ?? 0) - 1,
          ...original.locale === undefined ? {} : { locale: original.locale },
          inject: faceFor,
        }, component)
        active.set(key, { original, component, dispose })
      }
    }
    const unsubscribe = slots.subscribe(CHAT_NODE_SLOT, sync)
    sync()
    return () => {
      disposed = true
      unsubscribe()
      for (const wrapper of active.values()) wrapper.dispose()
      active.clear()
    }
  }, 'message-edit: 用户消息显示投影')
}
