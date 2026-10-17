import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'

// DSH 0.2.1-rc.1 的实际文档级拖放实现；保留快照使回归不依赖本机安装目录。
// 来源：@deepseek-ai/dsh-client-ui-attachment，桌面构建 ed75efeffee65f9fe93625bbd76a68cb219aaaf9。
// Copyright (c) 2026 DeepSeek；使用仓库 LICENSE 中保留的 MIT 许可。
const targetDropEvents = String.raw`		function droppedDirectories(dataTransfer, files) {
			const directories = /* @__PURE__ */ new Set();
			let fileIndex = 0;
			for (const item of dataTransfer.items) {
				if (item.kind !== "file") continue;
				const file = files[fileIndex++];
				if (typeof item.webkitGetAsEntry !== "function") continue;
				if (item.webkitGetAsEntry()?.isDirectory !== true) continue;
				if (file !== void 0) directories.add(file);
			}
			return directories;
		}

		function installDocumentDropEvents(canAcceptDrop, onAddFiles, dragDepth, setDragActive) {
			const fileTransfer = (event) => {
				const dataTransfer = event.dataTransfer;
				if (dataTransfer === null || !dataTransfer.types.includes("Files")) return null;
				return dataTransfer;
			};
			const reset = () => {
				dragDepth.current = 0;
				setDragActive(false);
			};
			const onDragEnter = (event) => {
				if (fileTransfer(event) === null) return;
				event.preventDefault();
				dragDepth.current += 1;
				setDragActive(true);
			};
			const onDragOver = (event) => {
				const dataTransfer = fileTransfer(event);
				if (dataTransfer === null) return;
				event.preventDefault();
				dataTransfer.dropEffect = canAcceptDrop ? "copy" : "none";
			};
			const onDragLeave = (event) => {
				if (fileTransfer(event) === null) return;
				dragDepth.current = Math.max(0, dragDepth.current - 1);
				if (dragDepth.current === 0) setDragActive(false);
				const leftViewport = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
				if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset();
			};
			const onDrop = (event) => {
				const dataTransfer = fileTransfer(event);
				if (dataTransfer === null) return;
				event.preventDefault();
				reset();
				if (canAcceptDrop) {
					const files = [...dataTransfer.files];
					onAddFiles(files, droppedDirectories(dataTransfer, files));
				}
			};
			document.addEventListener("dragenter", onDragEnter);
			document.addEventListener("dragover", onDragOver);
			document.addEventListener("dragleave", onDragLeave);
			document.addEventListener("drop", onDrop);
			window.addEventListener("dragend", reset);
			return () => {
				document.removeEventListener("dragenter", onDragEnter);
				document.removeEventListener("dragover", onDragOver);
				document.removeEventListener("dragleave", onDragLeave);
				document.removeEventListener("drop", onDrop);
				window.removeEventListener("dragend", reset);
			};
		}`

function extractHostDropEvents(source) {
  const start = source.indexOf('\t\tfunction droppedDirectories(')
  const end = source.indexOf('\n\t\t//#endregion', start)
  assert.ok(start >= 0 && end > start, '目标宿主应包含独立的文档拖放实现')
  return source.slice(start, end).replace(/\/\*\*[\s\S]*?\*\//g, '')
}

class Element {
  children = []
  listeners = new Map()
  attributes = new Map()
  dataset = {}
  nodeType = 1
  textContent = ''
  constructor(tagName, ownerDocument) { this.tagName = tagName.toUpperCase(); this.ownerDocument = ownerDocument }
  get childNodes() { return this.children }
  append(...nodes) {
    for (const node of nodes) { node.parentNode = this; this.children.push(node) }
  }
  appendChild(node) { this.append(node); return node }
  prepend(...nodes) { for (const node of nodes) node.parentNode = this; this.children.unshift(...nodes) }
  replaceChildren(...nodes) { for (const node of this.children) node.parentNode = undefined; this.children = []; this.append(...nodes) }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1)
    this.parentNode = undefined
  }
  setAttribute(name, value) { this.attributes.set(name, value) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false }
  closest(selector) {
    assert.equal(selector, '[role="dialog"]')
    for (let current = this; current; current = current.parentNode) if (current.getAttribute('role') === 'dialog') return current
    return null
  }
  focus() { this.ownerDocument.activeElement = this }
  addEventListener(name, callback, options) {
    const records = this.listeners.get(name) ?? []
    records.push({ callback, capture: typeof options === 'boolean' ? options : options?.capture ?? false })
    this.listeners.set(name, records)
  }
  removeEventListener(name, callback, options) {
    const capture = typeof options === 'boolean' ? options : options?.capture ?? false
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter(record => record.callback !== callback || record.capture !== capture))
  }
  dispatch(name, extra = {}) {
    const path = []
    for (let current = this; current; current = current.parentNode) path.push(current)
    const event = { type: name, target: this, defaultPrevented: false, stopped: false, immediate: false,
      clientX: 50, clientY: 50, composedPath: () => [...path],
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.stopped = true },
      stopImmediatePropagation() { this.immediate = true; this.stopped = true }, ...extra }
    const invoke = (node, capture, phase) => {
      event.currentTarget = node; event.eventPhase = phase
      for (const record of [...node.listeners.get(name) ?? []]) {
        if (record.capture === capture) record.callback(event)
        if (event.immediate) break
      }
    }
    // 与浏览器一致：祖先捕获先于目标，文档冒泡最后执行，与注册先后无关。
    for (const node of path.slice(1).reverse()) { invoke(node, true, 1); if (event.stopped) return event }
    invoke(this, true, 2)
    if (!event.immediate) invoke(this, false, 2)
    if (!event.stopped) for (const node of path.slice(1)) { invoke(node, false, 3); if (event.stopped) break }
    return event
  }
}

function fixture({ dialog = true, hostSource = targetDropEvents } = {}) {
  const document = new Element('document')
  document.ownerDocument = document
  document.documentElement = new Element('html', document)
  document.body = new Element('body', document)
  document.append(document.documentElement); document.documentElement.append(document.body)
  document.createElement = tag => new Element(tag, document)
  document.getSelection = () => null
  document.createRange = () => ({ selectNodeContents() {}, cloneContents: () => ({ nodeType: 11, childNodes: [] }) })
  const inserted = []
  document.execCommand = (_command, _ui, html) => { inserted.push(html) }
  const window = new Element('window')
  window.innerWidth = 1000; window.innerHeight = 800
  const outer = new Element('div', document)
  document.body.append(outer)
  const native = { files: [], active: false, phases: [], depth: { current: 0 } }
  const hostModule = { exports: {} }
  runInNewContext(`${hostSource}\nmodule.exports = installDocumentDropEvents`, { document, window, module: hostModule })
  const removeHost = hostModule.exports(true, files => { native.files.push([...files]) }, native.depth, active => { native.active = active })
  document.addEventListener('drop', event => native.phases.push(event.eventPhase))
  const panel = new Element('section', document)
  if (dialog) panel.setAttribute('role', 'dialog')
  const title = new Element('header', document)
  const container = new Element('div', document)
  const footer = new Element('footer', document)
  panel.append(title, container, footer); document.body.append(panel)
  const cache = new Map()
  const load = name => {
    if (name.endsWith('.css')) return { default: {} }
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsx
    if (cache.has(name)) return cache.get(name)
    const source = readFileSync(new URL(`../src/client/${name.slice(2)}`, import.meta.url), 'utf8')
    const { outputText } = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2024, jsx: ts.JsxEmit.ReactJSX,
    } })
    const module = { exports: {} }; cache.set(name, module.exports)
    runInNewContext(outputText, { module, exports: module.exports, require: load, document, window,
      AbortController, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, btoa, atob,
      __DSH_HOST_PATHS__: { pathFor: file => file.path ?? '' } })
    return module.exports
  }
  const created = [], released = [], busy = [], subscribers = new Set()
  let uploadStates = {}
  const attachmentTools = {
    create: files => files.map(file => {
      const id = `draft-${created.length + 1}`; const draft = { id, file, kind: file.type.startsWith('image/') ? 'image' : 'file', previewUrl: `blob:${id}` }
      created.push(draft)
      if (draft.kind === 'file') uploadStates[id] = { status: 'uploading', loaded: 0, total: file.size }
      return draft
    }),
    release: id => released.push(id), uploads: () => uploadStates,
    subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener) },
    serialize: async ids => ids.map(id => ({ type: 'file', receiptId: id })),
  }
  const tools = { options: async () => ({ current: {}, models: [], permissions: [] }) }
  const handle = load('./MessageComposer.ts').mountMessageComposer(container, { text: '原正文', attachments: [] }, attachmentTools, tools,
    { onBusy: value => busy.push(value), onSend() {}, onSave() {} })
  const frame = container.children[0], input = frame.children[1].children[0], attachments = frame.children[0], toolbar = frame.children.at(-1)
  return { handle, document, window, native, outer, panel, title, footer, frame, input, attachments, toolbar,
    created, released, busy, subscribers, inserted, removeHost,
    ready: () => { uploadStates = Object.fromEntries(created.map(draft => [draft.id, { status: 'ready' }])); for (const listener of subscribers) listener() } }
}

const file = (name = '文件.pdf', type = 'application/pdf') => ({ name, type, size: 512 })
const transfer = files => ({ types: ['Files'], files, items: files.map(value => ({ kind: 'file', getAsFile: () => value })), getData: () => '', dropEffect: 'none' })

test('宿主先注册的文档冒泡监听不会重复接收编辑器文件，捕获边界覆盖正文及附件和弹窗按钮', () => {
  const f = fixture()
  for (const [index, target] of [f.input, f.attachments, f.toolbar, f.title, f.footer].entries()) {
    const dataTransfer = transfer([file(`文件${index}.pdf`)])
    for (const type of ['dragenter', 'dragover']) {
      const event = target.dispatch(type, { dataTransfer })
      assert.equal(event.defaultPrevented, true)
      assert.equal(event.stopped, true)
      assert.equal(dataTransfer.dropEffect, 'copy')
    }
    target.dispatch('dragleave', { dataTransfer })
    target.dispatch('drop', { dataTransfer })
  }
  assert.equal(f.created.length, 5)
  assert.deepEqual(f.native.files, [])
  assert.deepEqual(f.native.phases, [])
  assert.equal(f.native.active, false)
  assert.equal(f.native.depth.current, 0)
  f.handle.dispose(); f.removeHost()
})

test('外部原生拖放不受影响，独立 composer 只接管自己的文件且释放全部监听和草稿', () => {
  const f = fixture({ dialog: false })
  const dataTransfer = transfer([file()])
  f.outer.dispatch('dragenter', { dataTransfer })
  assert.equal(f.native.active, true)
  f.outer.dispatch('drop', { dataTransfer })
  assert.equal(f.native.active, false)
  assert.equal(f.native.files.length, 1)
  assert.deepEqual(f.native.phases, [3])
  f.outer.dispatch('dragenter', { dataTransfer })
  f.input.dispatch('dragenter', { dataTransfer })
  f.outer.dispatch('dragleave', { dataTransfer })
  assert.equal(f.native.active, false)
  assert.equal(f.native.depth.current, 0)
  f.input.dispatch('drop', { dataTransfer })
  assert.equal(f.created.length, 1)
  assert.equal(f.native.files.length, 1)
  f.handle.dispose(); f.handle.dispose()
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) assert.equal(f.frame.listeners.get(type)?.length ?? 0, 0)
  assert.deepEqual(f.released, ['draft-1'])
  assert.equal(f.subscribers.size, 0)
  f.outer.dispatch('drop', { dataTransfer })
  assert.equal(f.native.files.length, 2)
  assert.equal(f.created.length, 1)
  f.removeHost()
})

test('忙碌时拒绝新增仍隔离原生输入框，上传状态及解除禁用后拖放保持可用', () => {
  const f = fixture()
  const dataTransfer = transfer([file()])
  f.input.dispatch('drop', { dataTransfer })
  assert.equal(f.busy.at(-1), true)
  f.ready(); assert.equal(f.busy.at(-1), false)
  f.handle.setDisabled(true)
  f.input.dispatch('dragover', { dataTransfer })
  assert.equal(dataTransfer.dropEffect, 'none')
  f.input.dispatch('drop', { dataTransfer })
  assert.equal(f.created.length, 1)
  assert.deepEqual(f.native.files, [])
  f.handle.setDisabled(false)
  f.input.dispatch('drop', { dataTransfer })
  assert.equal(f.created.length, 2)
  assert.equal(f.busy.at(-1), true)
  f.handle.dispose(); f.removeHost()
})

test('图片、桌面文件引用、文本拖放和粘贴仍走独立编辑草稿', () => {
  const f = fixture()
  f.input.dispatch('drop', { dataTransfer: transfer([file('图片.png', 'image/png'), { ...file(), path: 'D:\\资料\\说明.pdf' }]) })
  assert.equal(f.created.length, 1)
  assert.equal(f.created[0].kind, 'image')
  assert.match(f.inserted[0], /data-file-token="@D:\/资料\/说明.pdf"/)
  f.input.dispatch('drop', { dataTransfer: { types: ['text/plain'], files: [], getData: type => type === 'text/plain' ? '普通正文' : '' } })
  assert.equal(f.inserted.at(-1), '普通正文')
  f.input.dispatch('paste', { clipboardData: transfer([file('粘贴.png', 'image/png')]) })
  assert.equal(f.created.length, 2)
  assert.deepEqual(f.native.files, [])
  assert.equal(f.handle.text() === '原正文', false)
  f.handle.dispose(); f.removeHost()
})

// 本地目标安装资料可作为独立输入，直接运行同一份回归而非重新手写宿主 mock。
const installedClient = process.env.DSH_TARGET_ATTACHMENT_CLIENT
if (installedClient !== undefined) {
  assert.equal(existsSync(installedClient), true, '指定的目标附件客户端应当存在')
  test('目标已安装客户端的原始监听实现：编辑器文件不流入原生输入框', () => {
    const f = fixture({ hostSource: extractHostDropEvents(readFileSync(installedClient, 'utf8')) })
    const dataTransfer = transfer([file()])
    f.input.dispatch('dragenter', { dataTransfer }); f.input.dispatch('dragover', { dataTransfer }); f.input.dispatch('drop', { dataTransfer })
    assert.equal(f.created.length, 1)
    assert.deepEqual(f.native.files, [])
    assert.equal(f.native.active, false)
    f.outer.dispatch('drop', { dataTransfer })
    assert.equal(f.native.files.length, 1)
    f.handle.dispose(); f.removeHost()
  })
}
