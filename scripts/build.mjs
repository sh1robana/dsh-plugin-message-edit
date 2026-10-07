import { copyFile, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: pluginRoot, stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`))
    })
  })
}

const dist = join(pluginRoot, 'dist')
// 指纹覆盖源码与构建配置，使相同版本的旧产物也能被识别。
const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
const sourceFiles = (await readdir(join(pluginRoot, 'src'), { recursive: true }))
  .filter(file => /\.(ts|tsx|css)$/.test(file) && file !== 'build-info.ts')
  .map(file => 'src/' + file.replaceAll('\\', '/'))
const hash = createHash('sha256').update(manifest.version)
for (const file of [...sourceFiles, 'package.json', 'tsdown.config.ts', 'scripts/dsh-client-preset.ts', 'scripts/build.mjs'].sort()) {
  hash.update(file).update('\0').update(await readFile(join(pluginRoot, file))).update('\0')
}
const buildInfo = { version: manifest.version, buildId: hash.digest('hex').slice(0, 20),
  targetDshVersion: manifest.devDependencies['@deepseek-ai/dsh-session'] }
await writeFile(join(pluginRoot, 'src/build-info.ts'),
  '/** 由构建脚本生成；前后端共享同一份构建身份。 */\nexport const MESSAGE_EDIT_BUILD_INFO = Object.freeze(' + JSON.stringify(buildInfo, null, 2) + ')\n')
await rm(dist, { recursive: true, force: true })
await run(process.execPath, [join(pluginRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'])
await run(process.execPath, [join(pluginRoot, 'node_modules/tsdown/dist/run.mjs'), '--config', 'tsdown.config.ts'])
await copyFile(join(dist, 'index.js'), join(pluginRoot, 'index.mjs'))
await copyFile(join(dist, 'client.js'), join(pluginRoot, 'client.js'))
await copyFile(join(dist, 'client.js.map'), join(pluginRoot, 'client.js.map'))
const files = {}
for (const file of ['index.mjs', 'client.js', 'client.js.map']) {
  files[file] = createHash('sha256').update(await readFile(join(pluginRoot, file))).digest('hex')
}
await writeFile(join(pluginRoot, 'build-info.json'), JSON.stringify({ ...buildInfo, files }, null, 2) + '\n')
await rm(dist, { recursive: true, force: true })
