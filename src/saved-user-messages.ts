import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** 使用已知用户消息替换事件记录编辑，原日志与消息身份保持不变。 */
export interface SavedUserMessageSource {
  messageEdit?: { originalEventSeq: number }
}

export function savedUserMessageSeq(event: SessionEvent): number | undefined {
  if (event.type !== 'user/message' || typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace') return undefined
  const metadata = (event.data.source as UserMessage['source'] & SavedUserMessageSource).messageEdit
  const original = metadata?.originalEventSeq
  return Number.isSafeInteger(original) && (original as number) >= 0 ? original : undefined
}

/** 为聊天和历史操作还原用户可见文本；官方替换事件本身不增加聊天行。 */
export function savedUserMessages(events: readonly SessionEvent[]): Map<number, SessionEvent<'user/message'>> {
  const result = new Map<number, SessionEvent<'user/message'>>()
  for (const event of events) {
    const originalSeq = savedUserMessageSeq(event)
    if (originalSeq === undefined || event.type !== 'user/message') continue
    const original = events[originalSeq]
    if (original?.type !== 'user/message' || original.surfaceOp !== 'append' || original.data.id !== event.data.id) continue
    result.set(originalSeq, event)
  }
  return result
}

export function visibleUserEvents(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const saved = savedUserMessages(events)
  if (saved.size === 0) return events
  return events.map(event => {
    const replacement = saved.get(event.seq)
    return replacement === undefined ? event : { ...event, data: replacement.data } as SessionEvent
  })
}
