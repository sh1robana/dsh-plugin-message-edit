import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { CLIENT_EXTERNALS, PLATFORM_MODULES, clientBundle } from '../scripts/dsh-client-preset.ts'

test('客户端预设复用 DSH 0.2.1-rc.1、0.2.1-rc.2 的静态模块，不打包重复的宿主运行时', () => {
  const expected = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    'zod', '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ]
  assert.deepEqual(PLATFORM_MODULES, expected)
  assert.deepEqual(CLIENT_EXTERNALS, expected)
  const config = clientBundle('message-edit-test')
  assert.deepEqual(config.external, expected)
  for (const name of expected) assert.equal(config.noExternal(name), undefined)
  assert.equal(config.noExternal('immer'), true)
})

test('客户端纯度检查只放行宿主模块和可内联协议，拒绝复制其他插件的值', () => {
  const config = clientBundle('message-edit-test')
  const gate = config.plugins.find(plugin => plugin.name === 'dsh-client-bundle-purity')
  for (const name of CLIENT_EXTERNALS) assert.equal(gate.resolveId(name), null)
  for (const name of [
    '@deepseek-ai/cosmokit', '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-session/types', '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-api-session-controller/remote',
  ]) assert.equal(gate.resolveId(name), null)
  assert.throws(() => gate.resolveId('@deepseek-ai/dsh-client-ui-conversation/client'), /cross-plugin value imports are forbidden/)
})

test('客户端产物只登记工厂，宿主物化时才读取模块并执行副作用', () => {
  const id = 'message-edit-test'
  const config = clientBundle(id)
  let registration
  const effects = []
  const globals = {
    effects,
    window: { __ModuleLoader__: { load: descriptor => { registration = descriptor } } },
  }
  runInNewContext([
    config.outputOptions.banner,
    config.outputOptions.intro,
    'effects.push("执行工厂"); module.exports = require("@deepseek-ai/dsh-client-store");',
    config.outputOptions.footer,
  ].join('\n'), globals)
  assert.equal(registration.id, id)
  assert.deepEqual(effects, [])
  const store = {}
  assert.equal(registration.factory(name => {
    assert.equal(name, '@deepseek-ai/dsh-client-store')
    return store
  }), store)
  assert.deepEqual(effects, ['执行工厂'])
})

test('CSS 虚拟模块使用相对名称，仍追踪并读取原文件，发行产物不包含构建机路径', async () => {
  const config = clientBundle('message-edit-test')
  const css = config.plugins.find(plugin => plugin.name === 'dsh-css-modules-inline')
  const importer = fileURLToPath(new URL('../src/client/index.ts', import.meta.url))
  const stylesheet = fileURLToPath(new URL('../src/client/InlineMessageEdit.module.css', import.meta.url))
  const id = css.resolveId('./InlineMessageEdit.module.css', importer)
  assert.equal(id, '\0dsh-css:src/client/InlineMessageEdit.module.css.mjs')
  const watched = []
  const output = await css.load.call({ addWatchFile: file => watched.push(file) }, id)
  assert.deepEqual(watched, [stylesheet])
  assert.match(output, /export default/)
  const artifact = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(artifact.includes(process.cwd()), false)
  assert.equal(artifact.includes(process.cwd().replaceAll('\\', '/')), false)
  assert.doesNotMatch(artifact, /dsh-css:[A-Za-z]:[\\/]/)
})

// 指定目标安装包的实际加载器，检查本次构建产物而不连接或修改正在运行的宿主。
const installedModulesClient = process.env.DSH_TARGET_MODULES_CLIENT
if (installedModulesClient !== undefined) {
  test('目标实际模块加载器登记并延迟物化本次客户端产物，复用宿主静态模块及缓存', async () => {
    const [react, jsx, stores] = await Promise.all([
      import('react'), import('react/jsx-runtime'), import('@deepseek-ai/dsh-client-store'),
    ])
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const id = manifest.name
    const facade = {
      mode: 'queue', pendingQueue: [],
      load(registration) { this.pendingQueue.push(registration) },
    }
    let styleReads = 0
    const globals = {
      window: { __ModuleLoader__: facade }, console, setTimeout, clearTimeout, AbortController,
      document: {
        querySelectorAll: () => [],
        querySelector: () => { styleReads += 1; return {} },
      },
    }
    runInNewContext(readFileSync(installedModulesClient, 'utf8'), globals)
    const registration = facade.pendingQueue.shift()
    assert.equal(registration?.id, '@deepseek-ai/dsh-client-modules')
    const bootstrap = registration.factory(name => {
      assert.fail(`模块加载器引导不应读取尚未创建的静态模块：${name}`)
    })
    const modules = bootstrap.createClientModuleSystem(facade, { id: registration.id, exports: bootstrap }, {
      boot: {
        rev: 'message-edit-test', release: { version: manifest.devDependencies['@deepseek-ai/dsh-session'] },
        entries: [{ id, rev: 'message-edit-test', url: 'client.js' }],
        batches: [{ phase: 'application', url: 'client.js', rev: 'message-edit-test', entries: [id] }],
      },
      staticModules: { react, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-store': stores },
      loadBundle: () => { assert.fail('已登记的本地产物不应请求额外 bundle') },
    })
    runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), globals)
    assert.equal(modules.loadCache.has(id), false)
    assert.equal(styleReads, 0, '登记工厂时不应执行 CSS 副作用')
    const plugin = await modules.import(id)
    assert.equal(typeof plugin.apply, 'function')
    assert.ok(plugin.inject.includes('remote.commands'))
    assert.ok(plugin.inject.includes('remote.sessionReferenceResolver'))
    assert.equal(plugin.MESSAGE_EDIT_BUILD_INFO.targetDshVersion, manifest.devDependencies['@deepseek-ai/dsh-session'])
    assert.ok(styleReads > 0, '首次物化应执行客户端 CSS 模块')
    const readsAfterImport = styleReads
    assert.equal(await modules.import(id), plugin)
    assert.equal(styleReads, readsAfterImport, '重复 import 应复用缓存，不重跑工厂')
    for (const name of modules.loadCache.get(id).edges) assert.ok(CLIENT_EXTERNALS.includes(name), `产物请求了非静态模块：${name}`)
  })
}
