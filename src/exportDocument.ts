import JSZip from 'jszip'
import type { PMNode } from './history'
import { buildMarkdown } from './markdown'

type Options = {
  title: string
  json: PMNode
  onProgress?: (done: number, total: number) => void
}

/**
 * Builds a zip containing document.md plus every locally stored image and
 * attachment referenced by the document. Markdown uses relative paths
 * (images/... and files/...) so the folder works after unzipping.
 */
export async function exportDocument({ title, json, onProgress }: Options): Promise<void> {
  const { markdown, files } = buildMarkdown(json, title)
  const zip = new JSZip()
  zip.file('document.md', markdown, { compression: 'DEFLATE' })

  let done = 0
  onProgress?.(0, files.length)
  for (const file of files) {
    const response = await fetch(file.url)
    if (!response.ok) {
      throw new Error(`附件下载失败：${file.path}（HTTP ${response.status}）`)
    }
    const blob = await response.blob()
    zip.file(file.path, blob, { compression: 'STORE' })
    done++
    onProgress?.(done, files.length)
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  downloadBlob(blob, `${safeFileName(title, '文档')}.zip`)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function safeFileName(name: string, fallback: string): string {
  const value = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return (value || fallback).slice(0, 80)
}
