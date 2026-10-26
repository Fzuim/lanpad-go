import type { PMNode } from './history'

export type ExportFile = {
  /** App-relative asset URL, e.g. /assets/<docId>/<sha>.png */
  url: string
  /** Path inside the zip, e.g. images/<sha>.png or files/report.pdf */
  path: string
}

export type MarkdownResult = {
  markdown: string
  files: ExportFile[]
}

type Mark = {
  type?: string
  attrs?: Record<string, unknown>
}

type InlineNode = PMNode & { marks?: Mark[] }

class ExportContext {
  readonly files = new Map<string, ExportFile>()
  private readonly paths = new Map<string, string>()

  addFile(url: string, path: string): void {
    this.files.set(url, { url, path })
  }

  attachmentPath(name: string, url: string): string {
    const fallback = '附件'
    const base = safeFileName(name, fallback)
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    let candidate = `files/${base}`
    const existing = this.paths.get(candidate)
    if (existing === url) return candidate
    if (existing && existing !== url) {
      const suffix = basename(url).split('.')[0].slice(0, 8) || 'dup'
      candidate = `files/${stem}-${suffix}${ext}`
    }
    this.paths.set(candidate, url)
    return candidate
  }

  imagePath(url: string): string {
    const existing = [...this.files.values()].find((file) => file.url === url)
    if (existing) return existing.path
    const name = safeFileName(basename(url), 'image.png')
    let candidate = `images/${name}`
    const used = this.paths.get(candidate)
    if (used && used !== url) {
      candidate = `images/${urlHash(url)}-${name}`
    }
    this.paths.set(candidate, url)
    return candidate
  }
}

export function buildMarkdown(json: PMNode, title: string): MarkdownResult {
  const context = new ExportContext()
  const body = renderBlocks(json.content ?? [], context, '\n\n').trim()
  const heading = `# ${escapeText(title.trim() || '未命名文档')}`
  const markdown = body ? `${heading}\n\n${body}\n` : `${heading}\n`
  return { markdown, files: [...context.files.values()] }
}

function renderBlocks(nodes: PMNode[], context: ExportContext, separator = '\n\n'): string {
  return nodes
    .map((node) => renderBlock(node, context))
    .filter((block) => block.trim().length > 0)
    .join(separator)
}

function renderBlock(node: PMNode, context: ExportContext): string {
  switch (node.type) {
    case 'paragraph':
      return inlineContent(node, context)
    case 'heading': {
      const level = Math.max(1, Math.min(6, Number(node.attrs?.level ?? 1)))
      const text = inlineContent(node, context)
      return text ? `${'#'.repeat(level)} ${text}` : ''
    }
    case 'codeBlock': {
      const language =
        typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      const body = (node.content ?? []).map((child) => child.text ?? '').join('')
      const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1))
      return `${fence}${language}\n${body}\n${fence}`
    }
    case 'blockquote': {
      const inner = renderBlocks(node.content ?? [], context, '\n\n')
      if (!inner) return '>'
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n')
    }
    case 'bulletList':
      return (node.content ?? [])
        .map((item) => renderListItem(item, context, '- '))
        .join('\n')
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return (node.content ?? [])
        .map((item, index) => renderListItem(item, context, `${start + index}. `))
        .join('\n')
    }
    case 'horizontalRule':
      return '---'
    case 'image':
      return imageMarkdown(node, context)
    case 'attachment':
      return attachmentMarkdown(node, context)
    default:
      if (node.content) return renderBlocks(node.content, context, '\n\n')
      return inlineContent(node, context)
  }
}

function renderListItem(item: PMNode, context: ExportContext, marker: string): string {
  const blocks = (item.content ?? [])
    .map((child) => renderBlock(child, context))
    .filter((block) => block.trim().length > 0)
  if (blocks.length === 0) return marker.trimEnd()

  const lines = blocks.join('\n').split('\n')
  return [marker + (lines[0] ?? ''), ...lines.slice(1).map((line) => `  ${line}`)].join('\n')
}

function inlineContent(node: PMNode, context: ExportContext): string {
  return (node.content ?? []).map((child) => inlineNode(child, context)).join('')
}

function inlineNode(node: InlineNode, context: ExportContext): string {
  if (node.type === 'text') {
    let value = node.text ?? ''
    const marks = node.marks ?? []
    const hasMark = (name: string) => marks.some((mark) => mark.type === name)

    if (hasMark('code')) {
      value = codeSpan(value)
    } else {
      value = escapeText(value)
      if (hasMark('strike')) value = `~~${value}~~`
      if (hasMark('italic')) value = `*${value}*`
      if (hasMark('bold')) value = `**${value}**`
      if (hasMark('underline')) value = `<u>${value}</u>`
    }

    const link = marks.find((mark) => mark.type === 'link')
    const href = typeof link?.attrs?.href === 'string' ? link.attrs.href : ''
    if (href) value = `[${value}](${href})`
    return value
  }

  if (node.type === 'hardBreak') return '  \n'
  if (node.type === 'image') return imageMarkdown(node, context)
  if (node.type === 'attachment') return attachmentMarkdown(node, context)
  return inlineContent(node, context)
}

function imageMarkdown(node: PMNode, context: ExportContext): string {
  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
  const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '图片'
  if (!src) return `![${escapeText(alt)}]()`
  if (!isLocalAsset(src)) return `![${escapeText(alt)}](${src})`

  const path = context.imagePath(src)
  context.addFile(src, path)
  return `![${escapeText(alt)}](${encodePath(path)})`
}

function attachmentMarkdown(node: PMNode, context: ExportContext): string {
  const url = typeof node.attrs?.url === 'string' ? node.attrs.url : ''
  const name =
    typeof node.attrs?.name === 'string' && node.attrs.name.trim()
      ? node.attrs.name.trim()
      : basename(url) || '附件'
  if (!url) return `[${escapeText(name)}]()`
  if (!isLocalAsset(url)) return `[${escapeText(name)}](${url})`

  const path = context.attachmentPath(name, url)
  context.addFile(url, path)
  return `[${escapeText(name)}](${encodePath(path)})`
}

function isLocalAsset(url: string): boolean {
  return url.startsWith('/assets/')
}

function basename(url: string): string {
  const clean = url.split('?')[0].split('#')[0]
  return clean.slice(clean.lastIndexOf('/') + 1)
}

function urlHash(url: string): string {
  return basename(url).split('.')[0].slice(0, 8) || 'asset'
}

function safeFileName(name: string, fallback: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  const value = cleaned || fallback
  return value.slice(0, 120)
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/')
}

function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]])/g, '\\$1')
}

function codeSpan(text: string): string {
  const ticks = text.includes('`') ? '``' : '`'
  return `${ticks}${text}${ticks}`
}

function longestRun(text: string, char: string): number {
  let max = 0
  let current = 0
  for (const value of text) {
    if (value === char) {
      current++
      max = Math.max(max, current)
    } else {
      current = 0
    }
  }
  return max
}
