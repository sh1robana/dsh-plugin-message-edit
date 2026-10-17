import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { CLIENT_EXTERNALS, PLATFORM_MODULES, clientBundle } from '../scripts/dsh-client-preset.ts'

test('客户端预设复用 DSH 0.2.1-rc.1 的静态模块，不打包重复的宿主运行时', () => {
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
