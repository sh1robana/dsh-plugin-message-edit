export interface FileReferenceToken {
  readonly start: number
  readonly end: number
  readonly path: string
  readonly token: string
  readonly label: string
}

export interface SessionReferenceToken {
  readonly start: number
  readonly end: number
  readonly sessionId: string
  readonly token: string
  readonly label: string
}

interface HostPathBridge {
  pathFor(file: File): string
}

const invalidPathCharacters = /[\u0000-\u001f\u007f-\u009f"]/u

/** 使用桌面端提供的真实路径；浏览器内创建的文件没有宿主路径。 */
export function filePathFor(file: File): string | undefined {
  const bridge = (globalThis as typeof globalThis & { __DSH_HOST_PATHS__?: HostPathBridge }).__DSH_HOST_PATHS__
  try {
    const path = bridge?.pathFor(file)
    return path === undefined || path === '' ? undefined : path
  } catch {
    return undefined
  }
}

/** 对齐官方 @ 文件语法，空格使用双引号，路径分隔符统一为斜杠。 */
export function formatFileReference(path: string): string {
  if (path === '' || invalidPathCharacters.test(path)) throw new Error('文件路径无法表示为 DSH 引用。')
  const normalized = path.replace(/\\/gu, '/')
  return /\s/u.test(normalized) ? `@"${normalized}"` : `@${normalized}`
}

function pathFromClipboardLine(line: string): string | undefined {
  let path = line.trim()
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  if (/^file:/iu.test(path)) {
    try {
      const address = new URL(path)
      if (address.protocol !== 'file:' || address.search !== '' || address.hash !== '') return undefined
      path = decodeURIComponent(address.pathname)
      if (address.hostname !== '' && address.hostname !== 'localhost') path = `//${address.hostname}${path}`
      else if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1)
    } catch {
      return undefined
    }
  }
  if (invalidPathCharacters.test(path)) return undefined
  if (/^\/[^/]*$/u.test(path) && !/^\/[^\s]+\.[a-z0-9]+$/iu.test(path)) return undefined
  if (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/]|\/)/iu.test(path)) return undefined
  return path.replace(/\\/gu, '/')
}

/** 只读取剪贴板的路径文本；实际 File 由 filePathFor 处理，图片不会重复添加。 */
export function pastedFilePaths(data: DataTransfer): readonly string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const read = (type: string): string => {
    try { return data.getData(type) } catch { return '' }
  }
  for (const type of ['text/uri-list', 'text/plain']) {
    const lines = read(type).split(/\r\n|\n|\r/u).filter(line => line.trim() !== '' && (type !== 'text/uri-list' || !line.trimStart().startsWith('#')))
    const paths = lines.map(pathFromClipboardLine)
    // 一段普通说明中夹有路径不应丢掉说明文字，只有整批为路径时才接管粘贴。
    if (paths.some(path => path === undefined)) continue
    for (const path of paths) {
      if (path === undefined || seen.has(path)) continue
      seen.add(path)
      result.push(path)
    }
  }
  return result
}

/** 提取完整文件引用与文本位置；邮件地址和 @ 会话引用保留为普通文字。 */
export function parseFileReferences(text: string): readonly FileReferenceToken[] {
  const result: FileReferenceToken[] = []
  const pattern = /(?:^|\s)(@(?:"([^"\r\n]+)"|([^\s"]+)))/gu
  for (const match of text.matchAll(pattern)) {
    const token = match[1]
    const path = match[2] ?? match[3]
    if (token === undefined || path === undefined || invalidPathCharacters.test(path)) continue
    if (path.startsWith('[') || path.startsWith('dsh-session:')) continue
    const start = match.index + match[0].length - token.length
    const normalized = path.replace(/\\/gu, '/')
    const folder = normalized.endsWith('/')
    const segments = normalized.replace(/\/+$/u, '').split('/')
    const name = segments.at(-1) || normalized
    result.push({ start, end: start + token.length, path, token, label: `${name}${folder ? '/' : ''}` })
  }
  return result
}

function sessionReferenceUri(sessionId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sessionId))
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('')
  return `dsh-session:${btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`
}

/** 保持官方会话引用的 UTF-8 JSON 与 base64url 编码，显示名称独立于会话身份。 */
export function formatSessionReference(sessionId: string, label: string = sessionId): string {
  return `@[${label.replace(/[\\\]]/gu, character => `\\${character}`)}](${sessionReferenceUri(sessionId)})`
}

/** 识别 canonical 会话引用；错误 URI 继续保留文字，不生成可导航 chip。 */
export function parseSessionReferences(text: string): readonly SessionReferenceToken[] {
  const result: SessionReferenceToken[] = []
  const pattern = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu
  for (const match of text.matchAll(pattern)) {
    const uri = match[2] ?? match[3]
    if (uri === undefined) continue
    const payload = uri.slice('dsh-session:'.length)
    if (!/^[A-Za-z0-9_-]+$/u.test(payload)) continue
    try {
      const binary = atob(payload.replace(/-/gu, '+').replace(/_/gu, '/'))
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
      const sessionId: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (typeof sessionId !== 'string' || sessionReferenceUri(sessionId) !== uri) continue
      const token = match[0]
      const label = match[1] === undefined ? sessionId : match[1].replace(/\\(.)/gu, '$1')
      result.push({ start: match.index, end: match.index + token.length, sessionId, token, label })
    } catch {
      continue
    }
  }
  return result
}
