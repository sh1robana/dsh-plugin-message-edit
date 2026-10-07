import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'

class Element {
  children = []
  listeners = new Map()
  attributes = new Map()
  textContent = ''
  disabled = false
  clickCount = 0
  focusCount = 0
  constructor(tag) { this.tagName = tag }
  append(...elements) {
    for (const element of elements) {
      element.parent = this
      this.children.push(element)
    }
  }
  prepend(...elements) {
    for (const element of elements) element.parent = this
    this.children.unshift(...elements)
  }
  replaceChildren(...elements) {
    for (const child of this.children) child.parent = undefined
    this.children = []
    this.append(...elements)
  }
  setAttribute(name, value) { this.attributes.set(name, value) }
  getAttribute(name) { return this.attributes.get(name) }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(listener)
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener) }
  dispatch(name, extra = {}) {
    const event = {
      target: this,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.propagationStopped = true },
      ...extra,
    }
    for (const listener of this.listeners.get(name) ?? []) listener(event)
    return event
  }
  click() { this.clickCount += 1; this.dispatch('click') }
  focus() { this.focusCount += 1; if (this.ownerDocument) this.ownerDocument.activeElement = this }
  get isConnected() {
    let element = this
    while (element) {
      if (element.tagName === 'body') return true
      element = element.parent
    }
    return false
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }
}

function historicalImage(blockIndex = 1) {
  return Object.freeze({ blockIndex, content: Object.freeze({
    type: 'image',
    attachment: Object.freeze({ attachmentId: '历史图片', name: '原图.png', bytes: 512, width: 2, height: 2, mediaType: 'image/png' }),
  }) })
}

function historicalFile(blockIndex = 3) {
  return Object.freeze({ blockIndex, content: Object.freeze({
    type: 'file',
    attachment: Object.freeze({ attachmentId: '历史文件', name: '说明.pdf', bytes: 2048, mediaType: 'application/pdf' }),
  }) })
}

function fixture(initial = [], options = {}) {
  const module = { exports: {} }
  const document = new Element('document')
  document.body = new Element('body')
  document.createElement = tag => {
    const element = new Element(tag)
    element.ownerDocument = document
    return element
  }
  const source = readFileSync(new URL('../src/client/AttachmentEditor.tsx', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.ReactJSX },
  })
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    Error,
    document,
    require: name => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return jsx
      assert.equal(name, './InlineMessageEdit.module.css')
      return { default: {} }
    },
  })
  const container = new Element('div')
  const actions = options.actions ? new Element('footer') : undefined
  const save = new Element('button')
  save.textContent = '保存'
  actions?.append(save)
  document.body.append(container, ...actions ? [actions] : [])
  const calls = { create: [], serialize: [], release: [], retry: [], imageUrl: [], unsubscribe: 0 }
  const busy = []
  const listeners = new Set()
  const drafts = new Map()
  let uploads = {}
  let nextId = 1
  const tools = {
    create: files => {
      calls.create.push([...files])
      return Array.from(files, file => {
        const id = `draft-${nextId++}`
        const draft = file.type.startsWith('image/')
          ? { kind: 'image', id, file, previewUrl: `blob:${id}` }
          : { kind: 'file', id, file }
        drafts.set(id, draft)
        if (draft.kind === 'file') uploads[id] = { status: 'uploading', loaded: 0, total: file.size }
        return draft
      })
    },
    serialize: async ids => {
      calls.serialize.push([...ids])
      if (options.serialize) return options.serialize(ids)
      return Array.from(ids, id => {
        const draft = drafts.get(id)
        if (draft.kind === 'image') return { type: 'image', mediaType: draft.file.type, data: `base64:${id}`, name: draft.file.name }
        if (uploads[id]?.status !== 'ready') throw new Error('附件上传尚未完成')
        return { type: 'file', receiptId: uploads[id].receiptId }
      })
    },
    release: id => { calls.release.push(id); drafts.delete(id) },
    retry: id => calls.retry.push(id),
    uploads: () => uploads,
    subscribe: listener => {
      listeners.add(listener)
      return () => { calls.unsubscribe += 1; listeners.delete(listener) }
    },
    imageUrl: attachment => {
      calls.imageUrl.push(attachment)
      return options.imageUrl ? options.imageUrl(attachment) : Promise.resolve(`blob:stored-${attachment.attachmentId}`)
    },
  }
  const handle = module.exports.mountAttachmentEditor(container, initial, tools, value => busy.push(value), actions, options.editor)
  const list = container.children.find(element => element.getAttribute('aria-label') === '消息附件')
  const controls = actions ?? container
  const add = controls.children.find(element => element.tagName === 'button' && element.getAttribute('aria-label') === '添加附件')
  const picker = controls.children.find(element => element.tagName === 'input')
  const notice = container.children.find(element => element.getAttribute('role') === 'alert')
  return {
    handle, container, actions, save, list, add, picker, notice, calls, busy, listeners, document,
    pick: files => {
      picker.files = files
      picker.value = '选择的文件'
      picker.dispatch('change')
    },
    updateUpload: (id, state) => {
      uploads = { ...uploads, [id]: state }
      for (const listener of listeners) listener()
    },
    remove: index => list.children[index].children.find(element => element.getAttribute('aria-label')?.startsWith('移除附件：')).click(),
  }
}

const normalized = value => JSON.parse(JSON.stringify(value))
const previewOf = card => card.children[0].children[0]
const infoOf = card => card.children[0].children[1]
const pickedImage = () => ({ name: '新图.png', size: 512, type: 'image/png' })
const pickedFile = () => ({ name: '新说明.pdf', size: 4096, type: 'application/pdf' })

test('历史图片预览与文件卡显示名称及大小，附件按钮可放在原有操作区', async () => {
  const image = historicalImage()
  const file = historicalFile()
  const f = fixture([image, file], { actions: true })
  await new Promise(resolve => setImmediate(resolve))
  const [imageCard, fileCard] = f.list.children
  assert.equal(previewOf(imageCard).tagName, 'img')
  assert.equal(previewOf(imageCard).src, 'blob:stored-历史图片')
  assert.equal(previewOf(imageCard).alt, '原图.png')
  assert.equal(infoOf(imageCard).children[0].textContent, '原图.png')
  assert.equal(infoOf(imageCard).children[1].textContent, '512 B')
  assert.equal(previewOf(fileCard).tagName, 'span')
  assert.equal(previewOf(fileCard).textContent, '文件')
  assert.equal(infoOf(fileCard).children[0].textContent, '说明.pdf')
  assert.equal(infoOf(fileCard).children[1].textContent, '2.0 KB')
  assert.equal(f.calls.imageUrl[0], image.content.attachment)
  assert.deepEqual(f.actions.children, [f.add, f.picker, f.save])
  assert.deepEqual(f.busy, [false])
  f.handle.setDisabled(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.imageUrl.length, 1)
  f.handle.dispose()
  assert.deepEqual(f.actions.children, [f.save])
  assert.deepEqual(f.calls.release, [])
})

test('历史附件只序列化保留位置，删除全部后返回空列表且不释放持久附件', async () => {
  const f = fixture([historicalImage(2), historicalFile(5)])
  assert.deepEqual(normalized(await f.handle.serialize()), [
    { type: 'retained', blockIndex: 2 }, { type: 'retained', blockIndex: 5 },
  ])
  f.remove(0)
  assert.deepEqual(normalized(await f.handle.serialize()), [{ type: 'retained', blockIndex: 5 }])
  f.remove(0)
  assert.equal(f.list.children.length, 0)
  assert.deepEqual(normalized(await f.handle.serialize()), [])
  assert.deepEqual(f.calls.serialize, [])
  assert.deepEqual(f.calls.release, [])
  f.handle.dispose()
  assert.deepEqual(f.calls.release, [])
})

test('新增图片和文件沿用附件服务，序列化保持历史附件与两次选择的顺序', async () => {
  const f = fixture([historicalFile(5)])
  const image = pickedImage()
  const file = pickedFile()
  const secondImage = { ...pickedImage(), name: '第二张.png' }
  f.add.click()
  assert.equal(f.picker.clickCount, 1)
  f.pick([image, file])
  f.pick([secondImage])
  assert.deepEqual(f.calls.create, [[image, file], [secondImage]])
  assert.equal(f.picker.value, '')
  assert.equal(f.listeners.size, 1)
  assert.equal(previewOf(f.list.children[1]).src, 'blob:draft-1')
  f.updateUpload('draft-2', { status: 'ready', receiptId: 'file-receipt', file: {} })
  assert.equal(f.busy.at(-1), false)
  assert.deepEqual(normalized(await f.handle.serialize()), [
    { type: 'retained', blockIndex: 5 },
    { type: 'image', mediaType: 'image/png', data: 'base64:draft-1', name: '新图.png' },
    { type: 'file', receiptId: 'file-receipt' },
    { type: 'image', mediaType: 'image/png', data: 'base64:draft-3', name: '第二张.png' },
  ])
  assert.deepEqual(f.calls.serialize, [['draft-1', 'draft-2', 'draft-3']])
  assert.deepEqual(f.calls.release, [])
  f.handle.dispose()
})

test('上传中和上传失败均阻止保存，失败卡提供重试，上传完成或移除后解除忙碌', async () => {
  const f = fixture()
  f.pick([pickedFile()])
  assert.equal(f.busy.at(-1), true)
  assert.equal(infoOf(f.list.children[0]).children[1].textContent, '上传中 0%')
  f.updateUpload('draft-1', { status: 'uploading', loaded: 2048, total: 4096 })
  assert.equal(infoOf(f.list.children[0]).children[1].textContent, '上传中 50%')
  f.updateUpload('draft-1', { status: 'error', message: '连接中断' })
  assert.equal(f.busy.at(-1), true)
  assert.equal(infoOf(f.list.children[0]).children[1].textContent, '上传失败：连接中断')
  const retry = f.list.children[0].children.find(element => element.textContent === '重试上传')
  retry.click()
  assert.deepEqual(f.calls.retry, ['draft-1'])
  f.updateUpload('draft-1', { status: 'ready', receiptId: 'retry-receipt', file: {} })
  assert.equal(f.busy.at(-1), false)
  assert.equal(infoOf(f.list.children[0]).children[1].textContent, '4.0 KB')
  assert.deepEqual(normalized(await f.handle.serialize()), [{ type: 'file', receiptId: 'retry-receipt' }])
  f.pick([pickedFile()])
  assert.equal(f.busy.at(-1), true)
  f.remove(1)
  assert.equal(f.busy.at(-1), false)
  assert.deepEqual(f.calls.release, ['draft-2'])
  f.handle.dispose()
})

test('附件序列化失败保留可继续编辑的草稿，重试成功前不释放资源', async () => {
  const options = { serialize: async () => { throw new Error('读取图片失败') } }
  const f = fixture([historicalImage()], options)
  f.pick([pickedImage()])
  await assert.rejects(f.handle.serialize(), /读取图片失败/)
  assert.equal(f.list.children.length, 2)
  assert.deepEqual(f.calls.release, [])
  options.serialize = async () => []
  await assert.rejects(f.handle.serialize(), /附件尚未准备完成/)
  assert.equal(f.list.children.length, 2)
  assert.deepEqual(f.calls.release, [])
  options.serialize = async () => [{ type: 'image', mediaType: 'image/png', data: '重试后的图片' }]
  assert.deepEqual(normalized(await f.handle.serialize()), [
    { type: 'retained', blockIndex: 1 }, { type: 'image', mediaType: 'image/png', data: '重试后的图片' },
  ])
  assert.deepEqual(f.calls.serialize, [['draft-1'], ['draft-1'], ['draft-1']])
  f.handle.dispose()
  assert.deepEqual(f.calls.release, ['draft-1'])
})

test('保存期间禁用增删和重试，解除禁用恢复编辑，关闭释放新增草稿且幂等', async () => {
  const f = fixture([historicalImage()])
  f.pick([pickedImage(), pickedFile()])
  f.updateUpload('draft-2', { status: 'error', message: '上传失败' })
  f.handle.setDisabled(true)
  assert.equal(f.add.disabled, true)
  assert.equal(f.picker.disabled, true)
  const blockedRetry = f.list.children[2].children.find(element => element.textContent === '重试上传')
  assert.equal(blockedRetry.disabled, true)
  for (const card of f.list.children) assert.equal(card.children[1].disabled, true)
  f.remove(0)
  f.remove(1)
  blockedRetry.click()
  f.add.click()
  assert.equal(f.picker.clickCount, 0)
  f.pick([pickedImage()])
  assert.equal(f.list.children.length, 3)
  assert.equal(f.calls.create.length, 1)
  assert.deepEqual(f.calls.release, [])
  assert.deepEqual(f.calls.retry, [])
  f.handle.setDisabled(false)
  f.remove(1)
  assert.deepEqual(f.calls.release, ['draft-1'])
  const removeAfterClose = f.list.children[1].children[1]
  const retryAfterClose = f.list.children[1].children.find(element => element.textContent === '重试上传')
  const changeAfterClose = [...f.picker.listeners.get('change')][0]
  const busyCount = f.busy.length
  f.handle.dispose()
  f.handle.dispose()
  removeAfterClose.click()
  retryAfterClose.click()
  f.picker.files = [pickedImage()]
  changeAfterClose()
  f.updateUpload('draft-2', { status: 'ready', receiptId: '关闭后的上传', file: {} })
  assert.equal(f.container.children.length, 0)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.calls.unsubscribe, 1)
  assert.equal(f.calls.create.length, 1)
  assert.equal(f.busy.length, busyCount)
  assert.deepEqual(f.calls.release, ['draft-1', 'draft-2'])
  assert.deepEqual(f.calls.retry, [])
  assert.equal(f.add.listeners.get('click').size, 0)
  assert.equal(f.picker.listeners.get('change').size, 0)
})

test('公开选择和添加接口支持独立输入框接管文件，隐藏原按钮但保留选择器', () => {
  const routed = []
  const editor = { hideAdd: true, onFiles: files => routed.push([...files]) }
  const f = fixture([], { editor, actions: true })
  assert.equal(f.add, undefined)
  assert.deepEqual(f.actions.children, [f.picker, f.save])
  f.handle.pickFiles()
  assert.equal(f.picker.clickCount, 1)
  const image = pickedImage()
  const file = pickedFile()
  f.pick([image, file])
  assert.deepEqual(routed, [[image, file]])
  assert.deepEqual(f.calls.create, [])
  f.handle.addFiles([image])
  assert.deepEqual(f.calls.create, [[image]])
  assert.equal(f.list.children.length, 1)
  f.handle.setDisabled(true)
  f.handle.pickFiles()
  f.handle.addFiles([file])
  f.pick([file])
  assert.equal(f.picker.clickCount, 1)
  assert.equal(routed.length, 1)
  assert.equal(f.calls.create.length, 1)
  f.handle.setDisabled(false)
  editor.onFiles = () => { throw new Error('所选文件路径无法读取') }
  f.pick([file])
  assert.equal(f.notice.textContent, '所选文件路径无法读取')
  assert.equal(f.picker.value, '')
  f.handle.dispose()
  f.handle.pickFiles()
  f.handle.addFiles([file])
  assert.equal(f.picker.clickCount, 1)
  assert.equal(f.calls.create.length, 1)
})

test('历史图片和新草稿可点击放大，遮罩及 Escape 关闭，移除或销毁清理预览', async () => {
  const f = fixture([historicalImage()])
  const previews = () => f.document.body.children.filter(element => element.getAttribute('aria-label') === '图片预览')
  const historical = f.list.children[0].children[0]
  assert.equal(historical.tagName, 'button')
  assert.equal(historical.getAttribute('aria-label'), '放大图片：原图.png')
  historical.focus()
  historical.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(previews().length, 1)
  let overlay = previews()[0]
  assert.equal(overlay.getAttribute('role'), 'dialog')
  assert.equal(overlay.getAttribute('aria-modal'), 'true')
  assert.equal(overlay.children[0].src, 'blob:stored-历史图片')
  assert.equal(overlay.children[0].alt, '原图.png')
  assert.equal(f.document.activeElement, overlay.children[1])
  const tab = f.document.dispatch('keydown', { key: 'Tab' })
  assert.equal(tab.defaultPrevented, true)
  assert.equal(tab.propagationStopped, true)
  assert.equal(previews().length, 1)
  const escape = f.document.dispatch('keydown', { key: 'Escape' })
  assert.equal(escape.defaultPrevented, true)
  assert.equal(escape.propagationStopped, true)
  assert.equal(previews().length, 0)
  assert.equal(f.document.activeElement, historical)
  historical.click()
  await new Promise(resolve => setImmediate(resolve))
  overlay = previews()[0]
  overlay.dispatch('click', { target: overlay.children[0] })
  assert.equal(previews().length, 1)
  overlay.click()
  assert.equal(previews().length, 0)
  historical.click()
  await new Promise(resolve => setImmediate(resolve))
  f.remove(0)
  assert.equal(previews().length, 0)
  f.handle.addFiles([pickedImage()])
  const draft = f.list.children[0].children[0]
  draft.click()
  assert.equal(previews()[0].children[0].src, 'blob:draft-1')
  previews()[0].children[1].click()
  assert.equal(previews().length, 0)
  draft.click()
  assert.equal(previews().length, 1)
  f.handle.dispose()
  assert.equal(previews().length, 0)
  assert.equal(f.document.listeners.get('keydown').size, 0)
  assert.deepEqual(f.calls.release, ['draft-1'])
})

test('文件卡按历史位置或草稿对象调用默认打开回调，禁用期间不打开且错误可见', async () => {
  const opened = []
  let fail = false
  const editor = {
    openExisting: async index => { opened.push({ index }) },
    openDraft: async draft => {
      if (fail) throw new Error('默认应用暂不可用')
      opened.push({ id: draft.id, file: draft.file })
    },
  }
  const f = fixture([historicalFile(5)], { editor })
  const file = pickedFile()
  f.handle.addFiles([file])
  const existing = f.list.children[0].children[0]
  assert.equal(existing.getAttribute('aria-label'), '打开文件：说明.pdf')
  assert.equal(existing.title, '使用默认应用打开文件')
  existing.click()
  f.list.children[1].children[0].click()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(opened, [{ index: 5 }, { id: 'draft-1', file }])
  f.handle.setDisabled(true)
  for (const card of f.list.children) {
    assert.equal(card.children[0].disabled, true)
    card.children[0].click()
  }
  assert.equal(opened.length, 2)
  f.handle.setDisabled(false)
  fail = true
  f.list.children[1].children[0].click()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.notice.textContent, '默认应用暂不可用')
  assert.equal(f.list.children.length, 2)
  assert.deepEqual(f.calls.release, [])
  f.handle.dispose()
})

test('预览读取失败可以重试，关闭后晚到图片结果不会重新打开预览', async () => {
  let attempts = 0
  let resolveImage
  const f = fixture([historicalImage()], {
    imageUrl: () => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new Error('图片读取失败'))
      return new Promise(resolve => { resolveImage = resolve })
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(previewOf(f.list.children[0]).alt, '原图.png（预览暂不可用）')
  f.list.children[0].children[0].click()
  assert.equal(attempts, 2)
  f.handle.dispose()
  resolveImage('blob:晚到的历史图片')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.document.body.children.filter(element => element.getAttribute('role') === 'dialog').length, 0)
  assert.equal(f.calls.imageUrl.length, 2)
  assert.deepEqual(f.calls.release, [])
})
