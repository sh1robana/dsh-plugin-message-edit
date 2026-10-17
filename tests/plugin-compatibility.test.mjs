import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const supportedVersions = ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2']
const targetVersion = '0.2.1-rc.2'
const isDshPackage = name => name.startsWith('@deepseek-ai/dsh-')

test('顶层宿主声明明确包含目标 rc.2，并保留两个已有版本', () => {
  assert.equal(manifest.engines.dsh, supportedVersions.join(' || '))
  assert.equal(Object.hasOwn(manifest.dsh, 'engines'), false)
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (isDshPackage(name)) assert.equal(range, manifest.engines.dsh, name)
  }
})

test('目标开发依赖与构建身份一致，运行时仍复用宿主依赖', () => {
  const developmentPackages = Object.keys(manifest.devDependencies).filter(isDshPackage).sort()
  for (const name of Object.keys(manifest.peerDependencies).filter(isDshPackage)) {
    assert.ok(developmentPackages.includes(name), name)
  }
  assert.equal(Object.hasOwn(manifest.peerDependencies, '@deepseek-ai/dsh-session-format-v3-to-v4'), false)
  for (const name of developmentPackages) {
    assert.equal(manifest.devDependencies[name], targetVersion, name)
    assert.equal(Object.hasOwn(manifest.dependencies ?? {}, name), false, name)
  }
  const build = JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8'))
  assert.equal(build.version, manifest.version)
  assert.equal(build.targetDshVersion, targetVersion)
})
