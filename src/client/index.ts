/** Message Edit browser half: Timeline view and compact conversation-header controls. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MESSAGE_EDIT_VIEW_ORDER } from '../shared.ts'
import { MessageEditController } from './controller.ts'
import { MessageEditHeader } from './MessageEditHeader.tsx'
import { MessageEditTimelineView } from './MessageEditTimelineView.tsx'
import { registerUserMessageProjection } from './UserMessageProjection.tsx'
import { MESSAGE_EDIT_BUILD_INFO } from '../build-info.ts'
import { MESSAGE_EDIT_PATH } from '../shared.ts'
import { hostFetch } from './transport.ts'

export { MESSAGE_EDIT_BUILD_INFO } from '../build-info.ts'

/** Explicit value sources and slot declaration-order edges. */
export const inject = ['slots', 'uiConversation', 'conversation', 'uiWorkspace', 'connection', 'sessions',
  'commandUi', 'remote.commands', 'remote.sessionReferenceResolver']

/** Register both UI contributions over one per-session controller identity. */
export function apply(ctx: Context): void {
  const globals = globalThis as typeof globalThis & { __DSH_MESSAGE_EDIT__?: unknown }
  const diagnostics = Object.freeze({
    build: MESSAGE_EDIT_BUILD_INFO,
    diagnostics: async () => {
      const response = await hostFetch(`${MESSAGE_EDIT_PATH}?view=diagnostics`, {
        method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store',
      })
      if (!response.ok) throw new Error(`无法读取插件诊断：HTTP ${String(response.status)}`)
      const host = await response.json() as { build?: { version?: string; buildId?: string } }
      return { client: MESSAGE_EDIT_BUILD_INFO, host,
        matched: host.build?.version === MESSAGE_EDIT_BUILD_INFO.version && host.build?.buildId === MESSAGE_EDIT_BUILD_INFO.buildId }
    },
  })
  ctx.effect(() => {
    const previous = globals.__DSH_MESSAGE_EDIT__
    globals.__DSH_MESSAGE_EDIT__ = diagnostics
    return () => {
      if (globals.__DSH_MESSAGE_EDIT__ === diagnostics) {
        if (previous === undefined) delete globals.__DSH_MESSAGE_EDIT__
        else globals.__DSH_MESSAGE_EDIT__ = previous
      }
    }
  }, 'message-edit: 构建诊断')
  const controllers = new Map<SessionId, MessageEditController>()
  const controllerFor = (sessionId: SessionId): MessageEditController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new MessageEditController(ctx, sessionId)
      controllers.set(sessionId, controller)
    }
    return controller
  }

  registerUserMessageProjection(ctx, sessionId => controllerFor(sessionId).face)

  ctx.on('connection/reset', () => {
    for (const controller of controllers.values()) controller.refreshIfLoaded()
  })

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'message-edit-timeline',
    order: MESSAGE_EDIT_VIEW_ORDER,
    label: 'Timeline',
    inject: (sessionId: SessionId) => controllerFor(sessionId).face,
  }, MessageEditTimelineView))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'message-edit-controls',
    order: MESSAGE_EDIT_VIEW_ORDER,
    inject: (sessionId: SessionId) => controllerFor(sessionId).face,
  }, MessageEditHeader))
}
