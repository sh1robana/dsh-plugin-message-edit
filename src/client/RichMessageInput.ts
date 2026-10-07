import { parseFileReferences, parseSessionReferences, pastedFilePaths } from './fileReferences.ts'
import styles from './InlineMessageEdit.module.css'

export interface RichMessageInputHandle {
  text(): string
  insert(text: string): void
  replaceTrailing(token: string, text: string): void
  focus(): void
  setDisabled(disabled: boolean): void
  dispose(): void
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)
}

/** 引用以原生 @路径持久化，显示节点只负责高亮和点击。 */
function referenceHtml(text: string): string {
  let result = ''
  let offset = 0
  const sessions = parseSessionReferences(text)
  const files = parseFileReferences(text).filter(file => !sessions.some(session => file.start >= session.start && file.start < session.end))
  for (const reference of [...files, ...sessions].sort((left, right) => left.start - right.start)) {
    result += escapeHtml(text.slice(offset, reference.start)).replace(/\n/g, '<br>')
    const location = 'path' in reference ? `data-file-path="${escapeHtml(reference.path)}"` : `data-session-id="${escapeHtml(reference.sessionId)}"`
    result += `<span class="${styles['fileReference'] ?? ''}" contenteditable="false" role="link" tabindex="0" ${location} data-file-token="${escapeHtml(reference.token)}" title="${escapeHtml('path' in reference ? reference.path : reference.label)}">${'path' in reference ? '▤' : '@'} ${escapeHtml(reference.label)}</span>`
    offset = reference.end
  }
  return result + escapeHtml(text.slice(offset)).replace(/\n/g, '<br>')
}

/** 同时处理浏览器生成的段落和粘贴插入的换行，保留多行正文。 */
export function messageInputText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? ''
  const element = node as HTMLElement
  if (element.dataset?.['fileToken'] !== undefined) return element.dataset['fileToken']
  if (element.tagName === 'BR') return '\n'
  const children = Array.from(node.childNodes ?? [])
  let result = ''
  for (const child of children) {
    const block = child.nodeType === 1 && /^(DIV|P)$/.test((child as HTMLElement).tagName)
    if (block && result !== '' && !result.endsWith('\n')) result += '\n'
    result += messageInputText(child)
    if (block && child !== children.at(-1) && !result.endsWith('\n')) result += '\n'
  }
  return children.length === 0 ? node.textContent ?? '' : result.replace(/\u00a0/g, ' ')
}

/** 独立内容框使用浏览器编辑历史，不绑定主会话的单例草稿。 */
export function mountRichMessageInput(
  container: HTMLElement,
  initialText: string,
  options: {
    addFiles(files: readonly File[]): void
    addPaths(paths: readonly string[]): void
    openPath(path: string): Promise<void>
    openSession(sessionId: string): void
    onError(error: unknown): void
    onSend(): void
    onSave(): void
    onChange?(text: string): void
    onKeydown?(event: KeyboardEvent): boolean
  },
): RichMessageInputHandle {
  const input = document.createElement('div')
  input.className = `${styles['input'] ?? ''} ${styles['richInput'] ?? ''}`
  input.contentEditable = 'true'
  input.setAttribute('role', 'textbox')
  input.setAttribute('aria-label', '消息正文')
  input.setAttribute('aria-multiline', 'true')
  input.setAttribute('data-placeholder', '编辑消息，粘贴文件，输入 / 调用指令、@ 引用文件或对话')
  input.innerHTML = referenceHtml(initialText)
  container.append(input)
  let disabled = false
  let disposed = false
  let composing = false
  let edited = false
  let caret: Range | undefined
  const selection = (): Selection | null => document.getSelection()
  const remember = (): void => {
    const current = selection()
    if (current?.rangeCount && input.contains(current.anchorNode)) caret = current.getRangeAt(0).cloneRange()
  }
  const focus = (): void => {
    input.focus()
    const current = selection()
    if (current === null) return
    const range = caret ?? document.createRange()
    if (caret === undefined) { range.selectNodeContents(input); range.collapse(false) }
    current.removeAllRanges()
    current.addRange(range)
  }
  const changed = (): void => {
    if (composing) return
    edited = true
    remember()
    const current = selection()
    const prefix = document.createRange()
    prefix.selectNodeContents(input)
    if (current?.rangeCount && input.contains(current.anchorNode)) {
      const range = current.getRangeAt(0)
      prefix.setEnd(range.endContainer, range.endOffset)
    }
    options.onChange?.(messageInputText(prefix.cloneContents()))
  }
  const insert = (text: string): void => {
    if (disabled || disposed) return
    focus()
    const current = selection()
    if (current?.rangeCount && (parseFileReferences(text)[0]?.start === 0 || parseSessionReferences(text)[0]?.start === 0)) {
      const range = current.getRangeAt(0)
      const prefix = document.createRange()
      prefix.selectNodeContents(input)
      prefix.setEnd(range.startContainer, range.startOffset)
      const before = messageInputText(prefix.cloneContents())
      if (before !== '' && !/\s$/.test(before)) text = ` ${text}`
    }
    // 所有 HTML 来自转义后的文本与固定引用模板，富文本剪贴板不进入正文。
    document.execCommand('insertHTML', false, referenceHtml(text))
    changed()
  }
  const paste = (event: ClipboardEvent): void => {
    if (disabled || event.clipboardData === null) return
    const files = Array.from(event.clipboardData.files)
    if (!files.length) for (const item of Array.from(event.clipboardData.items)) {
      const file = item.kind === 'file' ? item.getAsFile() : null
      if (file !== null) files.push(file)
    }
    const paths = files.length === 0 ? pastedFilePaths(event.clipboardData) : []
    event.preventDefault()
    if (files.length) options.addFiles(files)
    else if (paths.length) options.addPaths(paths)
    else insert(event.clipboardData.getData('text/plain'))
  }
  const drop = (event: DragEvent): void => {
    if (disabled || event.dataTransfer === null) return
    event.preventDefault()
    const files = Array.from(event.dataTransfer.files)
    if (files.length) options.addFiles(files)
    else {
      const paths = pastedFilePaths(event.dataTransfer)
      if (paths.length) options.addPaths(paths)
      else insert(event.dataTransfer.getData('text/plain'))
    }
  }
  const dragOver = (event: DragEvent): void => { if (!disabled) event.preventDefault() }
  const openReference = (event: MouseEvent | KeyboardEvent): void => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-file-path], [data-session-id]')
    if (chip === null || !input.contains(chip)) return
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    const path = chip.dataset['filePath']
    if (path !== undefined) void options.openPath(path).catch(options.onError)
    const sessionId = chip.dataset['sessionId']
    if (sessionId !== undefined) options.openSession(sessionId)
  }
  const keydown = (event: KeyboardEvent): void => {
    if (composing || event.isComposing || event.keyCode === 229 || disabled) return
    if ((event.target as HTMLElement).dataset['fileToken'] !== undefined) { openReference(event); return }
    if (options.onKeydown?.(event)) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); options.onSave()
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault(); options.onSend()
    }
  }
  const copy = (event: ClipboardEvent): void => {
    const current = selection()
    if (current?.rangeCount && input.contains(current.anchorNode) && event.clipboardData !== null) {
      event.clipboardData.setData('text/plain', messageInputText(current.getRangeAt(0).cloneContents()))
      event.preventDefault()
      if (event.type === 'cut' && !disabled) document.execCommand('delete')
    }
  }
  const compositionStart = (): void => { composing = true }
  const compositionEnd = (): void => { composing = false; changed() }
  input.addEventListener('compositionstart', compositionStart)
  input.addEventListener('compositionend', compositionEnd)
  input.addEventListener('input', changed)
  input.addEventListener('keyup', remember)
  input.addEventListener('mouseup', remember)
  input.addEventListener('blur', remember)
  input.addEventListener('paste', paste)
  input.addEventListener('drop', drop)
  input.addEventListener('dragover', dragOver)
  input.addEventListener('click', openReference)
  input.addEventListener('keydown', keydown)
  input.addEventListener('copy', copy)
  input.addEventListener('cut', copy)
  return {
    // 未输入时直接使用原始值，避免浏览器的空白归一化制造虚假修改。
    text: () => edited ? messageInputText(input) : initialText, insert, focus,
    replaceTrailing: (token, text) => {
      if (disabled || disposed) return
      focus()
      const current = selection()
      if (current === null) return
      for (let index = 0; index < token.length; index++) current.modify('extend', 'backward', 'character')
      remember()
      insert(text)
    },
    setDisabled: value => { disabled = value; input.contentEditable = String(!value); input.setAttribute('aria-disabled', String(value)) },
    dispose: () => {
      disposed = true
      input.removeEventListener('compositionstart', compositionStart)
      input.removeEventListener('compositionend', compositionEnd)
      input.removeEventListener('input', changed)
      input.removeEventListener('keyup', remember)
      input.removeEventListener('mouseup', remember)
      input.removeEventListener('blur', remember)
      input.removeEventListener('paste', paste)
      input.removeEventListener('drop', drop)
      input.removeEventListener('dragover', dragOver)
      input.removeEventListener('click', openReference)
      input.removeEventListener('keydown', keydown)
      input.removeEventListener('copy', copy)
      input.removeEventListener('cut', copy)
      input.remove()
    },
  }
}
