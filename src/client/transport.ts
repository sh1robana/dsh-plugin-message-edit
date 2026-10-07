import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client'

/** 使用页面提供的宿主传输，兼容桌面端的自定义协议和普通 Web 页面。 */
export function hostFetch(input: string, init: RequestInit): Promise<Response> {
  const globals = globalThis as typeof globalThis & { __DSH_TRANSPORT__?: ClientTransportHooks }
  const path = input.replace(/^\//, '')
  const transport = globals.__DSH_TRANSPORT__
  return transport?.fetch !== undefined
    ? transport.fetch(path, init)
    : globalThis.fetch(path, init)
}
