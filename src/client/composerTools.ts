import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MESSAGE_EDIT_PATH, type MessageEditComposerOptions, type MessageEditSettings } from '../shared.ts'
import { hostFetch } from './transport.ts'

export interface ComposerModelOption {
  provider: string
  model: string
  label: string
  reasoningEfforts: readonly string[]
}

export type ComposerSettings = MessageEditSettings
export type ComposerOptions = MessageEditComposerOptions

export type ComposerReference = {
  path: string
  label: string
  kind: 'file' | 'folder'
} | { sessionId: string; mention: string; label: string; kind: 'session' }

export interface ComposerCommand {
  name: string
  label?: string
  description?: string
  hint?: string
  section?: string
}

interface CommandUiService {
  candidates(scope: { sessionId: SessionId }, request: { query: string; position: 'leading'; signal: AbortSignal }): Promise<readonly ComposerCommand[]>
  execute(scope: { sessionId: SessionId }, line: string): Promise<{ kind: 'success' } | { kind: 'error'; text: string }>
}

/** 编辑器使用同一宿主服务，但不写入主输入框的 SessionInput。 */
export interface MessageComposerTools {
  options(): Promise<ComposerOptions>
  references(query: string, signal: AbortSignal): Promise<readonly ComposerReference[]>
  openPath(path: string): Promise<void>
  openSession(sessionId: string): void
  openAttachment(eventSeq: number, blockIndex: number): Promise<void>
  openUpload(receiptId: string): Promise<void>
  command(line: string): Promise<void>
  commands(query: string, signal: AbortSignal): Promise<readonly ComposerCommand[]>
}

async function readResponse(response: Response): Promise<unknown> {
  const value = await response.json() as { error?: string }
  if (!response.ok) throw new Error(value.error ?? `请求失败：HTTP ${String(response.status)}`)
  return value
}

export function composerTools(ctx: Context, sessionId: SessionId): MessageComposerTools {
  const get = async (query: Record<string, string>, signal?: AbortSignal): Promise<unknown> => {
    const params = new URLSearchParams({ sessionId, ...query })
    return readResponse(await hostFetch(`${MESSAGE_EDIT_PATH}?${params}`, {
      method: 'GET', cache: 'no-store', ...signal === undefined ? {} : { signal },
    }))
  }
  const post = async (operation: Record<string, unknown>): Promise<void> => {
    await readResponse(await hostFetch(MESSAGE_EDIT_PATH, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...operation }),
    }))
  }
  return {
    options: async () => await get({ view: 'options' }) as ComposerOptions,
    references: async (query, signal) => {
      const remote = ctx.get('remote') as unknown as { sessionReferenceResolver?: {
        candidates(sessionId: SessionId, query: string, signal: AbortSignal): Promise<{ ok: true; value: readonly { sessionId: string; mention: string; label: string }[] } | { ok: false; error: { message: string } }>
      } } | undefined
      const [files, sessions] = await Promise.all([
        get({ view: 'references', query }, signal) as Promise<readonly ComposerReference[]>,
        remote?.sessionReferenceResolver?.candidates(sessionId, query, signal),
      ])
      return [...files, ...sessions?.ok ? sessions.value.map(item => ({ ...item, kind: 'session' as const })) : []]
    },
    openPath: path => post({ action: 'open-reference', path }),
    openSession: id => { ctx.uiWorkspace.openSession(id as SessionId) },
    openAttachment: (eventSeq, blockIndex) => post({ action: 'open-attachment', eventSeq, blockIndex }),
    openUpload: receiptId => post({ action: 'open-upload', receiptId }),
    commands: async (query, signal) => {
      const commands = ctx.get('commandUi') as unknown as CommandUiService | undefined
      return commands === undefined ? [] : commands.candidates({ sessionId }, { query, position: 'leading', signal })
    },
    command: async line => {
      const commands = ctx.get('commandUi') as unknown as CommandUiService | undefined
      if (commands !== undefined) {
        const result = await commands.execute({ sessionId }, line)
        if (result.kind === 'error') throw new Error(result.text)
        return
      }
      const sessions = ctx.get('sessions') as unknown as ISessions
      const session = sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error('当前会话尚未就绪，请稍后重试。')
      const result = await session.command(line)
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value.matched) throw new Error('当前 DSH 未提供此指令。')
    },
  }
}
