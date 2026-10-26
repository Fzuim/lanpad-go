import type * as Y from 'yjs'
import type { NetworkInfo } from './types'

export const COLORS = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#ea580c',
  '#4f46e5',
]

export function pickColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)]
}

export function getInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

export function sanitizeName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 24)
}

export function formatRelative(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 10_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  })
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function chooseBase(network: NetworkInfo | null): string {
  if (typeof window !== 'undefined' && !isLoopbackHost(window.location.hostname)) {
    return window.location.origin
  }
  return network?.primary ?? window.location.origin
}

export function makeWsUrl(_docId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/collab`
}

/** Replace a Y.Text's content with the shortest possible delete/insert. */
export function replaceYText(text: Y.Text, next: string): void {
  const prev = text.toString()
  if (prev === next) return

  let start = 0
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++

  let prevEnd = prev.length
  let nextEnd = next.length
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--
    nextEnd--
  }

  text.doc?.transact(() => {
    if (prevEnd > start) text.delete(start, prevEnd - start)
    if (nextEnd > start) text.insert(start, next.slice(start, nextEnd))
  })
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Clipboard API is unavailable on plain-http LAN origins; use the fallback.
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    textarea.remove()
    return ok
  } catch {
    return false
  }
}

export function randomName(): string {
  return `队员-${Math.floor(10 + Math.random() * 90)}`
}
