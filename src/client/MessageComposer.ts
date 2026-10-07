import type { EditableMessageBlock, MessageEditAttachmentInput } from '../shared.ts'
import type { MessageAttachmentTools } from './attachmentTools.ts'
import type { ComposerOptions, ComposerSettings, MessageComposerTools } from './composerTools.ts'
import { mountAttachmentEditor, type AttachmentEditorHandle } from './AttachmentEditor.tsx'
import { filePathFor, formatFileReference } from './fileReferences.ts'
import { mountRichMessageInput, type RichMessageInputHandle } from './RichMessageInput.ts'
import styles from './InlineMessageEdit.module.css'

export interface MessageComposerHandle {
  text(): string
  settings(regenerate?: boolean): ComposerSettings | undefined
  serialize(): Promise<readonly MessageEditAttachmentInput[]>
  focus(): void
  setDisabled(disabled: boolean): void
  dispose(): void
}

function button(label: string, className?: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  if (className !== undefined) element.className = className
  return element
}

/** 弹窗与 Timeline 共用独立的正文、附件及提交选项。 */
export function mountMessageComposer(container: HTMLElement, block: EditableMessageBlock,
  attachmentTools: MessageAttachmentTools, tools: MessageComposerTools,
  events: { onBusy(busy: boolean): void; onSend(): void; onSave(): void },
): MessageComposerHandle {
  const frame = document.createElement('div')
  frame.className = styles['composer'] ?? ''
  const attachments = document.createElement('div')
  const inputContainer = document.createElement('div')
  const toolbar = document.createElement('div')
  toolbar.className = styles['composerToolbar'] ?? ''
  const plus = button('+', styles['composerPlus'])
  plus.setAttribute('aria-label', '添加文件')
  plus.title = '添加文件'
  const permission = button('权限 ▾', styles['composerControl'])
  permission.setAttribute('aria-label', '修改权限')
  const model = button('模型 ▾', styles['composerModel'])
  model.setAttribute('aria-label', '修改模型和推理等级')
  const status = document.createElement('div')
  status.className = styles['attachmentNotice'] ?? ''
  status.setAttribute('role', 'status')
  const popup = document.createElement('div')
  popup.className = styles['composerMenu'] ?? ''
  popup.hidden = true
  const suggestions = document.createElement('div')
  suggestions.className = styles['referenceSuggestions'] ?? ''
  suggestions.hidden = true
  toolbar.append(plus, permission, model)
  frame.append(attachments, inputContainer, suggestions, popup, toolbar)
  container.append(frame, status)
  let disabled = false
  let disposed = false
  let options: ComposerOptions | undefined
  let draftSettings: ComposerSettings = {}
  let search: AbortController | undefined
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let highlighted = 0
  let richInput: RichMessageInputHandle
  let attachmentEditor: AttachmentEditorHandle
  const showError = (error: unknown): void => { if (!disposed) status.textContent = error instanceof Error ? error.message : String(error) }
  const addPaths = (paths: readonly string[]): void => {
    richInput.insert(paths.map(path => formatFileReference(path)).join(' ') + ' ')
  }
  const addFiles = (files: readonly File[]): void => {
    if (disabled || disposed) return
    const uploads: File[] = []
    const paths: string[] = []
    for (const file of files) {
      const path = filePathFor(file)
      if (path !== undefined && !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) paths.push(path)
      else uploads.push(file)
    }
    if (paths.length) addPaths(paths)
    if (uploads.length) attachmentEditor.addFiles(uploads)
  }
  const closeMenu = (): void => {
    popup.hidden = true
    permission.setAttribute('aria-expanded', 'false')
    model.setAttribute('aria-expanded', 'false')
  }
  const beginMenu = (label: string, kind: 'permission' | 'model' | 'modelList' | 'command' = 'command'): void => {
    popup.replaceChildren()
    popup.setAttribute('role', 'menu')
    popup.setAttribute('aria-label', label)
    popup.dataset['kind'] = kind
    popup.hidden = false
    permission.setAttribute('aria-expanded', String(kind === 'permission'))
    model.setAttribute('aria-expanded', String(kind === 'model' || kind === 'modelList'))
  }
  const menuItem = (label: string, description: string, act: () => void, selected?: boolean, target = popup): HTMLButtonElement => {
    const item = button('')
    const text = document.createElement('span')
    text.className = styles['menuItemLabel'] ?? ''
    text.textContent = label
    item.setAttribute('role', selected === undefined ? 'menuitem' : 'menuitemradio')
    if (selected !== undefined) item.setAttribute('aria-checked', String(selected))
    item.title = label
    const hint = document.createElement('span')
    hint.className = styles['menuValue'] ?? ''
    hint.textContent = selected === undefined ? description : selected ? '✓' : ''
    if (selected !== undefined) hint.setAttribute('aria-hidden', 'true')
    item.append(text, hint)
    item.disabled = disabled
    item.addEventListener('click', () => { closeMenu(); act() })
    target.append(item)
    return item
  }
  const permissionLabel = (id: string | undefined): string => {
    const labels: Record<string, string> = {
      'read-only': '仅可查看', 'workspace-write': '工作区内修改',
      'danger-full-access': '完全权限', 'auto-review': 'Auto review',
    }
    return id === undefined ? '权限' : labels[id] ?? options?.permissions.find(preset => preset.id === id)?.label ?? (id === 'custom' ? '自定义权限' : id)
  }
  const effortLabel = (effort: string | undefined): string => {
    if (!effort) return '默认'
    const values = { ...options?.current, ...draftSettings }
    const selected = options?.models.find(entry => entry.provider === values.provider && entry.model === values.model)
    return selected?.reasoningEffortLabels?.[effort] ?? ({ off: 'Off', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' } as Record<string, string>)[effort] ?? effort
  }
  const updateControls = (): void => {
    const values = { ...options?.current, ...draftSettings }
    permission.textContent = `${permissionLabel(values.permissionPreset)} ▾`
    const selected = options?.models.find(entry => entry.provider === values.provider && entry.model === values.model)
    model.textContent = `${selected?.label ?? values.model ?? '模型'}${values.reasoningEffort ? ` ${effortLabel(values.reasoningEffort)}` : ''} ▾`
    model.title = model.textContent
  }
  const permissionMenu = (): void => {
    beginMenu('选择权限', 'permission')
    const values = { ...options?.current, ...draftSettings }
    for (const preset of options?.permissions ?? []) {
      const item = menuItem(permissionLabel(preset.id), '', () => { draftSettings.permissionPreset = preset.id; updateControls(); richInput.focus() }, preset.id === values.permissionPreset)
      item.title = preset.description ?? permissionLabel(preset.id)
    }
    if (options === undefined) menuItem('重新加载选项', '', () => { void loadOptions() })
  }
  const modelMenu = (): void => {
    beginMenu('选择模型和推理等级', 'model')
    const values = { ...options?.current, ...draftSettings }
    const selected = options?.models.find(entry => entry.provider === values.provider && entry.model === values.model)
    menuItem('模型', `${selected?.label ?? values.model ?? '选择模型'} ›`, modelList)
    if (selected?.reasoningEfforts.length) {
      menuItem('推理等级', `${effortLabel(values.reasoningEffort)} ›`, () => {
        beginMenu('选择推理等级', 'model')
        menuItem('‹ 推理等级', '', modelMenu)
        for (const effort of ['', ...selected.reasoningEfforts]) menuItem(effortLabel(effort), '', () => {
          draftSettings = { ...draftSettings, provider: selected.provider, model: selected.model, reasoningEffort: effort }
          updateControls(); richInput.focus()
        }, effort === (values.reasoningEffort ?? ''))
      })
    }
    if (options === undefined) menuItem('重新加载选项', '', () => { void loadOptions() })
  }
  const modelList = (): void => {
    beginMenu('选择模型', 'modelList')
    const back = menuItem('‹ 模型', '', modelMenu)
    back.className = styles['menuBack'] ?? ''
    const field = document.createElement('input')
    field.placeholder = '搜索模型…'
    field.setAttribute('aria-label', '搜索模型')
    field.className = styles['modelSearch'] ?? ''
    const list = document.createElement('div')
    list.className = styles['modelList'] ?? ''
    popup.append(field, list)
    const render = (): void => {
      // 搜索框保持挂载，筛选时不丢失焦点和光标。
      list.replaceChildren()
      const values = { ...options?.current, ...draftSettings }
      const query = field.value.trim().toLocaleLowerCase()
      const groups = new Map<string, ComposerOptions['models'][number][]>()
      for (const entry of options?.models ?? []) {
        if (query && !`${entry.label} ${entry.model} ${entry.providerLabel ?? entry.provider}`.toLocaleLowerCase().includes(query)) continue
        const group = groups.get(entry.provider) ?? []
        group.push(entry); groups.set(entry.provider, group)
      }
      for (const entries of groups.values()) {
        const heading = document.createElement('div')
        heading.className = styles['menuHeading'] ?? ''
        heading.textContent = entries[0]?.providerLabel ?? entries[0]?.provider ?? ''
        list.append(heading)
        for (const entry of entries) menuItem(entry.label, '', () => {
          draftSettings = { ...draftSettings, provider: entry.provider, model: entry.model }
          if (!entry.reasoningEfforts.includes(values.reasoningEffort ?? '')) {
            // 不将旧模型不支持的推理等级传给新模型。
            draftSettings.reasoningEffort = ''
          }
          updateControls(); richInput.focus()
        }, entry.provider === values.provider && entry.model === values.model, list)
      }
      if (!groups.size) {
        const empty = document.createElement('div')
        empty.className = styles['menuHeading'] ?? ''
        empty.textContent = '没有找到匹配的模型'
        list.append(empty)
      }
    }
    field.addEventListener('input', render)
    render()
    field.focus()
  }
  const executeCommand = (line: string): void => {
    if (disabled) return
    status.textContent = '正在执行指令…'
    void tools.command(line).then(() => { if (!disposed) status.textContent = '指令已执行。' }).catch(showError)
  }
  const commandForm = (name: string, label: string, placeholder: string): void => {
    beginMenu(label)
    const field = document.createElement('input')
    field.placeholder = placeholder
    field.setAttribute('aria-label', label)
    const run = button(label)
    run.addEventListener('click', () => { closeMenu(); executeCommand(`/${name}${field.value.trim() ? ` ${field.value.trim()}` : ''}`) })
    popup.append(field, run)
    field.focus()
  }
  const planMenu = (): void => {
    beginMenu('计划模式')
    menuItem('进入计划模式', '先规划，再执行', () => executeCommand('/plan'))
    menuItem('退出计划模式', '恢复正常对话', () => executeCommand('/plan off'))
  }
  const chooseCommand = (name: string): void => {
    switch (name) {
      case 'file': attachmentEditor.pickFiles(); break
      case 'goal': commandForm('goal', '设置或查看目标', '输入目标；留空查看当前目标'); break
      case 'plan': planMenu(); break
      case 'feedback': commandForm('feedback', '发送反馈', '输入反馈内容'); break
      case 'permission': permissionMenu(); break
      case 'model': modelMenu(); break
      default: executeCommand(`/${name}`)
    }
  }
  const suggestReferences = (text: string): void => {
    search?.abort()
    if (searchTimer !== undefined) clearTimeout(searchTimer)
    suggestions.hidden = true
    const slash = /^\/([^\s]*)$/.exec(text)
    const match = /(?:^|\s)@([^\s@]*)$/.exec(text)
    if (slash !== null) {
      const controller = new AbortController()
      search = controller
      void tools.commands(slash[1] ?? '', controller.signal).then(commands => {
        if (disposed || controller.signal.aborted || !commands.length) return
        suggestions.replaceChildren()
        suggestions.setAttribute('role', 'listbox')
        suggestions.setAttribute('aria-label', '指令候选')
        for (const command of commands.slice(0, 12)) {
          const item = button(`${command.label ?? command.name} /${command.name}`)
          item.setAttribute('role', 'option')
          item.addEventListener('mousedown', event => event.preventDefault())
          item.addEventListener('click', () => {
            suggestions.hidden = true
            richInput.replaceTrailing(`/${slash[1] ?? ''}`, '')
            chooseCommand(command.name)
          })
          suggestions.append(item)
        }
        highlighted = 0
        suggestions.hidden = false
        suggestions.children[0]?.setAttribute('aria-selected', 'true')
      }).catch(error => { if (!controller.signal.aborted) showError(error) })
      return
    }
    if (match === null) return
    const query = match[1] ?? ''
    searchTimer = setTimeout(() => {
      const controller = new AbortController()
      search = controller
      void tools.references(query, controller.signal).then(results => {
        if (disposed || controller.signal.aborted || !results.length) return
        suggestions.replaceChildren()
        suggestions.setAttribute('role', 'listbox')
        suggestions.setAttribute('aria-label', '文件引用候选')
        for (const reference of results.slice(0, 12)) {
          const item = button(`${reference.kind === 'folder' ? '▱' : reference.kind === 'session' ? '@' : '▤'} ${reference.label}`)
          item.title = reference.kind === 'session' ? reference.label : reference.path
          item.setAttribute('role', 'option')
          item.addEventListener('mousedown', event => event.preventDefault())
          item.addEventListener('click', () => {
            richInput.replaceTrailing(`@${query}`, `${reference.kind === 'session' ? reference.mention : formatFileReference(reference.path)} `)
            suggestions.hidden = true
          })
          suggestions.append(item)
        }
        suggestions.hidden = false
        highlighted = 0
        suggestions.children[0]?.setAttribute('aria-selected', 'true')
      }).catch(error => { if (!controller.signal.aborted) showError(error) })
    }, 150)
  }
  richInput = mountRichMessageInput(inputContainer, block.text, {
    addFiles, addPaths, openPath: tools.openPath, openSession: tools.openSession, onError: showError,
    onSend: events.onSend, onSave: events.onSave, onChange: suggestReferences,
    onKeydown: event => {
      if (suggestions.hidden) return false
      if (event.key === 'Escape') { suggestions.hidden = true; event.preventDefault(); return true }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const direction = event.key === 'ArrowUp' ? -1 : 1
        highlighted = (highlighted + direction + suggestions.children.length) % suggestions.children.length
        for (const [index, item] of Array.from(suggestions.children).entries()) item.setAttribute('aria-selected', String(index === highlighted))
        event.preventDefault(); return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        (suggestions.children[highlighted] as HTMLButtonElement | undefined)?.click()
        event.preventDefault(); return true
      }
      return false
    },
  })
  attachmentEditor = mountAttachmentEditor(attachments, block.attachments ?? [], attachmentTools, events.onBusy, undefined, {
    hideAdd: true, onFiles: addFiles,
    openExisting: blockIndex => tools.openAttachment(block.eventSeq, blockIndex),
    openDraft: async draft => {
      const path = filePathFor(draft.file)
      if (path !== undefined) return tools.openPath(path)
      const [payload] = await attachmentTools.serialize([draft.id])
      if (payload?.type !== 'file') throw new Error('附件尚未准备完成，请稍后重试。')
      await tools.openUpload(payload.receiptId)
    },
  })
  const loadOptions = async (): Promise<void> => {
    try {
      const result = await tools.options()
      if (!Array.isArray(result.models) || !Array.isArray(result.permissions)) throw new Error('宿主尚未提供编辑选项，请安装新版插件并重启 DSH。')
      if (disposed) return
      options = result
      updateControls()
    } catch (error) { showError(error) }
  }
  const outside = (event: MouseEvent): void => {
    const path = event.composedPath()
    if (!path.includes(popup) && !path.includes(plus) && !path.includes(permission) && !path.includes(model)) closeMenu()
  }
  const togglePermission = (): void => {
    if (!popup.hidden && popup.getAttribute('aria-label') === '选择权限') closeMenu()
    else permissionMenu()
  }
  const toggleModel = (): void => {
    if (!popup.hidden && (popup.dataset['kind'] === 'model' || popup.dataset['kind'] === 'modelList')) closeMenu()
    else modelMenu()
  }
  frame.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && !popup.hidden) { closeMenu(); richInput.focus(); event.stopPropagation() }
  })
  plus.addEventListener('click', () => { closeMenu(); attachmentEditor.pickFiles() })
  permission.addEventListener('click', togglePermission)
  model.addEventListener('click', toggleModel)
  document.addEventListener('click', outside)
  void loadOptions()
  return {
    text: richInput.text,
    settings: regenerate => {
      const settings = { ...regenerate ? options?.current : {}, ...draftSettings }
      if (settings.permissionPreset !== undefined && !options?.permissions.some(item => item.id === settings.permissionPreset)) {
        delete settings.permissionPreset
      }
      if (settings.reasoningEffort === '') delete settings.reasoningEffort
      return Object.keys(settings).length ? settings : undefined
    },
    serialize: () => attachmentEditor.serialize(),
    focus: richInput.focus,
    setDisabled: value => {
      disabled = value
      richInput.setDisabled(value)
      attachmentEditor.setDisabled(value)
      plus.disabled = value; permission.disabled = value; model.disabled = value
      if (value) { closeMenu(); suggestions.hidden = true }
    },
    dispose: () => {
      disposed = true
      search?.abort()
      if (searchTimer !== undefined) clearTimeout(searchTimer)
      document.removeEventListener('click', outside)
      attachmentEditor.dispose()
      richInput.dispose()
      frame.remove(); status.remove()
    },
  }
}
