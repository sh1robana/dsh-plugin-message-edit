import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  ComposerAttachment,
  ConversationController,
  DraftAttachmentId,
  DraftFileUploads,
  SubmitAttachment,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** 附件草稿独立于主输入框，沿用官方上传、序列化与资源释放流程。 */
export interface MessageAttachmentTools {
  create(files: readonly File[]): readonly ComposerAttachment[]
  serialize(ids: readonly DraftAttachmentId[]): Promise<readonly SubmitAttachment[]>
  release(id: DraftAttachmentId): void
  retry(id: DraftAttachmentId): void
  uploads(): DraftFileUploads
  subscribe(listener: () => void): () => void
  imageUrl(attachment: ImageAttachmentRef): Promise<string>
}

export function attachmentTools(ctx: Context, sessionId: SessionId): MessageAttachmentTools {
  const conversation = (): ConversationController => {
    const service = ctx.get('conversation') as ConversationController | undefined
    if (service === undefined) throw new Error('DSH 附件服务尚未就绪，请重启后重试。')
    return service
  }
  return {
    create: files => conversation().createDrafts(sessionId, files),
    serialize: async ids => (await conversation().serializeDraftAttachments(ids)).attachments,
    release: id => { conversation().releaseDraftAttachment(id) },
    retry: id => { conversation().retryFileUpload(sessionId, id) },
    uploads: () => conversation().fileUploads.getSnapshot(),
    subscribe: listener => conversation().fileUploads.subscribe(listener),
    imageUrl: attachment => ctx.uiConversation.imageUrl(sessionId, attachment),
  }
}
