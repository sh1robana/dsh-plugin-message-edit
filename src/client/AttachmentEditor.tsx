import { useEffect, useRef, type ReactNode } from 'react'
import type { ComposerAttachment } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { EditableMessageAttachment, MessageEditAttachmentInput } from '../shared.ts'
import type { MessageAttachmentTools } from './attachmentTools.ts'
import styles from './InlineMessageEdit.module.css'

type AttachmentItem = { existing: EditableMessageAttachment } | { draft: ComposerAttachment }

export interface AttachmentEditorHandle {
  addFiles(files: readonly File[]): void
  pickFiles(): void
  serialize(): Promise<readonly MessageEditAttachmentInput[]>
  setDisabled(disabled: boolean): void
  dispose(): void
}

export interface AttachmentEditorOptions {
  onFiles?(files: readonly File[]): void
  hideAdd?: boolean
  openExisting?(blockIndex: number): Promise<void>
  openDraft?(draft: ComposerAttachment): Promise<void>
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 两种编辑入口共享附件草稿，关闭编辑器时仅释放新增附件。 */
export function mountAttachmentEditor(
  container: HTMLElement,
  initial: readonly EditableMessageAttachment[],
  tools: MessageAttachmentTools,
  onBusy: (busy: boolean) => void,
  actions?: HTMLElement,
  options: AttachmentEditorOptions = {},
): AttachmentEditorHandle {
  const items: AttachmentItem[] = initial.map(existing => ({ existing }))
  const list = document.createElement('div')
  list.className = styles['attachmentList'] ?? ''
  list.setAttribute('aria-label', '消息附件')
  const add = document.createElement('button')
  add.type = 'button'
  add.className = `${styles['attachmentAdd'] ?? ''} ${styles['attachmentAddCircle'] ?? ''}`
  add.textContent = '＋'
  add.setAttribute('aria-label', '添加附件')
  add.title = '添加图片或文件；替换附件时，先移除原附件再添加新文件。'
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.multiple = true
  picker.hidden = true
  picker.setAttribute('aria-label', '选择消息附件')
  const notice = document.createElement('div')
  notice.className = styles['attachmentNotice'] ?? ''
  notice.setAttribute('role', 'alert')
  if (actions === undefined) container.append(list, ...options.hideAdd ? [] : [add], picker, notice)
  else {
    container.append(list, notice)
    actions.prepend(...options.hideAdd ? [] : [add], picker)
  }
  let disposed = false
  let disabled = false
  let unsubscribe: (() => void) | undefined
  const imageUrls = new Map<number, Promise<string>>()
  let previewItem: AttachmentItem | undefined
  let previewRevision = 0
  let dismissPreview: (() => void) | undefined

  const closePreview = (): void => {
    previewRevision += 1
    previewItem = undefined
    dismissPreview?.()
    dismissPreview = undefined
  }
  const imageUrl = (existing: EditableMessageAttachment): Promise<string> => {
    if (existing.content.type !== 'image') throw new Error('此附件不是图片。')
    let url = imageUrls.get(existing.blockIndex)
    if (url === undefined) {
      url = tools.imageUrl(existing.content.attachment)
      imageUrls.set(existing.blockIndex, url)
      void url.catch(() => {
        if (imageUrls.get(existing.blockIndex) === url) imageUrls.delete(existing.blockIndex)
      })
    }
    return url
  }
  const showPreview = (src: string, name: string, item: AttachmentItem): void => {
    closePreview()
    previewItem = item
    const previousFocus = document.activeElement as HTMLElement | null
    const overlay = document.createElement('div')
    overlay.className = styles['attachmentLightbox'] ?? ''
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', '图片预览')
    const image = document.createElement('img')
    image.className = styles['attachmentOriginal'] ?? ''
    image.src = src
    image.alt = name
    const close = document.createElement('button')
    close.type = 'button'
    close.className = styles['attachmentPreviewClose'] ?? ''
    close.textContent = '×'
    close.setAttribute('aria-label', '关闭图片预览')
    const outside = (event: MouseEvent): void => { if (event.target === overlay) closePreview() }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') closePreview()
      else close.focus()
    }
    overlay.append(image, close)
    overlay.addEventListener('click', outside)
    close.addEventListener('click', closePreview)
    document.addEventListener('keydown', key, true)
    dismissPreview = () => {
      document.removeEventListener('keydown', key, true)
      overlay.removeEventListener('click', outside)
      close.removeEventListener('click', closePreview)
      overlay.remove()
      if (previousFocus?.isConnected) previousFocus.focus()
    }
    // 挂到 body 避免编辑弹窗的滚动和变换裁切图片原图。
    document.body.append(overlay)
    close.focus()
  }
  const openAttachment = async (item: AttachmentItem, name: string): Promise<void> => {
    if (disabled || disposed || !items.includes(item)) return
    notice.textContent = ''
    const content = 'existing' in item ? item.existing.content : undefined
    const draft = 'draft' in item ? item.draft : undefined
    try {
      if (content?.type === 'image' || draft?.kind === 'image') {
        closePreview()
        const revision = previewRevision
        previewItem = item
        let src: string
        if (draft?.kind === 'image') src = draft.previewUrl
        else if ('existing' in item) src = await imageUrl(item.existing)
        else return
        if (!disabled && !disposed && items.includes(item) && revision === previewRevision) showPreview(src, name, item)
      } else if ('existing' in item) {
        if (options.openExisting === undefined) throw new Error('当前编辑入口尚不支持打开文件。')
        await options.openExisting(item.existing.blockIndex)
      } else {
        if (options.openDraft === undefined) throw new Error('当前编辑入口尚不支持打开文件。')
        await options.openDraft(item.draft)
      }
    } catch (error) {
      if (!disposed) notice.textContent = error instanceof Error ? error.message : String(error)
    }
  }

  const refresh = (): void => {
    if (disposed) return
    const uploads = items.some(item => 'draft' in item && item.draft.kind === 'file') ? tools.uploads() : {}
    const pending = items.some(item => 'draft' in item && item.draft.kind === 'file'
      && uploads[item.draft.id]?.status !== 'ready')
    const cards = items.map((item) => {
      const card = document.createElement('div')
      card.className = styles['attachmentCard'] ?? ''
      const content = 'existing' in item ? item.existing.content : undefined
      const draft = 'draft' in item ? item.draft : undefined
      const name = content?.attachment.name ?? draft?.file.name ?? '图片附件'
      const bytes = content?.attachment.bytes ?? draft?.file.size ?? 0
      const isImage = content?.type === 'image' || draft?.kind === 'image'
      const open = document.createElement('button')
      open.type = 'button'
      open.className = styles['attachmentOpen'] ?? ''
      open.setAttribute('data-kind', isImage ? 'image' : 'file')
      open.setAttribute('aria-label', isImage ? `放大图片：${name}` : `打开文件：${name}`)
      open.title = isImage ? '点击放大图片' : '使用默认应用打开文件'
      open.disabled = disabled
      open.addEventListener('click', () => { void openAttachment(item, name) })
      const preview = document.createElement(isImage ? 'img' : 'span')
      preview.className = styles['attachmentPreview'] ?? ''
      if (isImage) {
        const image = preview as HTMLImageElement
        image.alt = name
        if (draft?.kind === 'image') image.src = draft.previewUrl
        if (content?.type === 'image' && 'existing' in item) {
          const url = imageUrl(item.existing)
          void url.then(value => { if (!disposed) image.src = value }).catch(() => {
            if (!disposed) image.alt = `${name}（预览暂不可用）`
          })
        }
      } else {
        preview.textContent = '文件'
      }
      const info = document.createElement('div')
      info.className = styles['attachmentInfo'] ?? ''
      const label = document.createElement('span')
      label.textContent = name
      label.title = name
      const status = document.createElement('span')
      status.className = styles['attachmentStatus'] ?? ''
      const upload = draft?.kind === 'file' ? uploads[draft.id] : undefined
      status.textContent = upload?.status === 'error' ? `上传失败：${upload.message}`
        : draft?.kind === 'file' && upload?.status !== 'ready'
          ? upload?.status === 'uploading' && upload.total
            ? `上传中 ${String(Math.round(upload.loaded / upload.total * 100))}%`
            : '正在上传…'
          : sizeLabel(bytes)
      info.append(label, status)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = styles['attachmentRemove'] ?? ''
      remove.textContent = '×'
      remove.title = `移除 ${name}`
      remove.setAttribute('aria-label', `移除附件：${name}`)
      remove.disabled = disabled
      remove.addEventListener('click', () => {
        if (disabled || disposed) return
        const index = items.indexOf(item)
        if (index < 0) return
        items.splice(index, 1)
        if (previewItem === item) closePreview()
        if ('draft' in item) tools.release(item.draft.id)
        refresh()
      })
      open.append(preview, info)
      card.append(open, remove)
      if (upload?.status === 'error' && draft !== undefined) {
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.textContent = '重试上传'
        retry.disabled = disabled
        retry.addEventListener('click', () => { if (!disabled && !disposed) tools.retry(draft.id) })
        card.append(retry)
      }
      return card
    })
    list.replaceChildren(...cards)
    add.disabled = disabled
    picker.disabled = disabled
    onBusy(pending)
  }
  const addFiles = (files: readonly File[]): void => {
    if (disabled || disposed || files.length === 0) return
    try {
      for (const draft of tools.create(files)) items.push({ draft })
      unsubscribe ??= tools.subscribe(refresh)
      notice.textContent = ''
      refresh()
    } catch (error) {
      notice.textContent = error instanceof Error ? error.message : String(error)
    }
  }
  const openPicker = (): void => { if (!disabled && !disposed) picker.click() }
  const picked = (): void => {
    try {
      if (!disabled && !disposed) {
        const files = Array.from(picker.files ?? [])
        if (files.length > 0) (options.onFiles ?? addFiles)(files)
      }
    } catch (error) {
      notice.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      picker.value = ''
    }
  }
  add.addEventListener('click', openPicker)
  picker.addEventListener('change', picked)
  refresh()
  return {
    addFiles,
    pickFiles: openPicker,
    serialize: async () => {
      const drafts = items.flatMap(item => 'draft' in item ? [item.draft.id] : [])
      const uploaded = drafts.length === 0 ? [] : await tools.serialize(drafts)
      let index = 0
      return items.map(item => {
        if ('existing' in item) return { type: 'retained', blockIndex: item.existing.blockIndex }
        const attachment = uploaded[index++]
        if (attachment === undefined) throw new Error('附件尚未准备完成，请稍后重试。')
        return attachment
      })
    },
    setDisabled: value => { disabled = value; if (value) closePreview(); refresh() },
    dispose: () => {
      if (disposed) return
      disposed = true
      closePreview()
      unsubscribe?.()
      add.removeEventListener('click', openPicker)
      picker.removeEventListener('change', picked)
      for (const item of items) if ('draft' in item) tools.release(item.draft.id)
      add.remove()
      picker.remove()
      container.replaceChildren()
    },
  }
}

/** Timeline 复用弹窗的附件编辑器，不把主输入框的草稿带入历史消息。 */
export function AttachmentEditor({ initial, tools, onMount, onBusy, disabled }: {
  initial: readonly EditableMessageAttachment[]
  tools: MessageAttachmentTools
  onMount(handle: AttachmentEditorHandle | undefined): void
  onBusy(busy: boolean): void
  disabled: boolean
}): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<AttachmentEditorHandle | undefined>(undefined)
  const callbacks = useRef({ onMount, onBusy })
  callbacks.current = { onMount, onBusy }
  useEffect(() => {
    if (container.current === null) return
    const handle = mountAttachmentEditor(container.current, initial, tools, busy => callbacks.current.onBusy(busy))
    editor.current = handle
    callbacks.current.onMount(handle)
    return () => {
      callbacks.current.onMount(undefined)
      handle.dispose()
      editor.current = undefined
    }
  }, [initial, tools])
  useEffect(() => { editor.current?.setDisabled(disabled) }, [disabled])
  return <div ref={container} className={styles['attachmentEditor']} />
}
