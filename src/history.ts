import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { formatFileSize } from './files'

export type PMNode = {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: PMNode[]
}

export type VersionContent = {
  json: PMNode
  title: string
  text: string
}

export type DiffRow = {
  kind: 'same' | 'add' | 'remove'
  text: string
  oldLine?: number
  newLine?: number
}

/** Decode a stored Yjs V1 update into ProseMirror JSON plus plain text. */
export function decodeVersionState(state: string): VersionContent {
  const binary = atob(state)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, bytes)
    // Tiptap's Collaboration extension is configured with field: 'content'.
    // Fall back to the older `default` field for documents written before
    // that setting was introduced.
    let raw = yDocToProsemirrorJSON(doc, 'content') as PMNode | undefined
    if (!raw?.content?.length) {
      raw = yDocToProsemirrorJSON(doc, 'default') as PMNode | undefined
    }
    const json: PMNode = raw && raw.type ? raw : { type: 'doc', content: [] }
    const title = doc.getText('title').toString()
    return { json, title, text: prosemirrorJSONToText(json) }
  } finally {
    doc.destroy()
  }
}

/** Convert ProseMirror JSON to readable markdown-ish plain text. */
export function prosemirrorJSONToText(json: PMNode): string {
  return renderBlock(json).join('\n')
}

function inlineText(node: PMNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'image') return imageText(node)
  return (node.content ?? []).map(inlineText).join('')
}

function imageText(node: PMNode): string {
  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
  return src ? `![图片](${src})` : '[图片]'
}

function childBlocks(node: PMNode): string[] {
  return (node.content ?? []).flatMap(renderBlock)
}

function renderBlock(node: PMNode): string[] {
  switch (node.type) {
    case 'doc':
      return childBlocks(node)
    case 'paragraph':
      return [inlineText(node)]
    case 'heading': {
      const level = Number(node.attrs?.level ?? 1)
      return [`${'#'.repeat(Math.max(1, Math.min(6, level)))} ${inlineText(node)}`]
    }
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      return ['```' + language, ...inlineText(node).split('\n'), '```']
    }
    case 'blockquote':
      return childBlocks(node).map((line) => `> ${line}`)
    case 'bulletList':
      return (node.content ?? []).flatMap((item) => renderListItem(item, '- '))
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return (node.content ?? []).flatMap((item, index) =>
        renderListItem(item, `${start + index}. `),
      )
    }
    case 'horizontalRule':
      return ['---']
    case 'image':
      return [imageText(node)]
    case 'attachment': {
      const name = typeof node.attrs?.name === 'string' ? node.attrs.name : '附件'
      const size = Number(node.attrs?.size ?? 0)
      return [`[附件] ${name}${size > 0 ? ` (${formatFileSize(size)})` : ''}`]
    }
    default:
      return node.content ? childBlocks(node) : [inlineText(node)]
  }
}

function renderListItem(item: PMNode, bullet: string): string[] {
  const lines = childBlocks(item)
  if (lines.length === 0) return [bullet.trimEnd()]
  return [bullet + lines[0], ...lines.slice(1).map((line) => `  ${line}`)]
}

/**
 * Line-based LCS diff. `before` is the selected version, `after` is the
 * current document, so removed lines are "restoring would delete these".
 */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length

  // A pathological paste should not freeze the modal.
  if (n * m > 4_000_000) {
    return [
      ...a.map((text, index) => ({ kind: 'remove' as const, text, oldLine: index + 1 })),
      ...b.map((text, index) => ({ kind: 'add' as const, text, newLine: index + 1 })),
    ]
  }

  const cols = m + 1
  const dp = new Uint32Array((n + 1) * cols)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * cols + j] =
        a[i] === b[j]
          ? dp[(i + 1) * cols + j + 1] + 1
          : Math.max(dp[(i + 1) * cols + j], dp[i * cols + j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  let oldLine = 1
  let newLine = 1
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i], oldLine, newLine })
      i++
      j++
      oldLine++
      newLine++
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
      rows.push({ kind: 'remove', text: a[i], oldLine })
      i++
      oldLine++
    } else {
      rows.push({ kind: 'add', text: b[j], newLine })
      j++
      newLine++
    }
  }
  while (i < n) {
    rows.push({ kind: 'remove', text: a[i], oldLine })
    i++
    oldLine++
  }
  while (j < m) {
    rows.push({ kind: 'add', text: b[j], newLine })
    j++
    newLine++
  }
  return rows
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
