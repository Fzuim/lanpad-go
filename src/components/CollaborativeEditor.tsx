import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'
import type { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'
import { uploadAsset, uploadAttachment } from '../api'
import { Attachment, type AttachmentAttrs } from '../editor/Attachment'
import { fileExtension } from '../files'
import type { UserInfo } from '../types'

const lowlight = createLowlight(common)
const MAX_UPLOAD = 10 * 1024 * 1024
const MAX_SOURCE = 25 * 1024 * 1024
const MAX_ATTACHMENT = 50 * 1024 * 1024
const MAX_WIDTH = 2560
const MAX_PIXELS = 40_000_000

type Props = {
  docId: string
  ydoc: Y.Doc
  provider: WebsocketProvider
  user: UserInfo
  readOnly: boolean
  onEditor: (editor: Editor | null) => void
  onContentChange: (characters: number) => void
  onImageClick: (src: string) => void
  onError: (message: string) => void
  registerUpload: (upload: ((files: File[]) => Promise<void>) | null) => void
}

type PreparedImage = {
  file: File
  width: number | null
  height: number | null
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  const fromFiles = Array.from(data.files ?? [])
  if (fromFiles.length) return fromFiles
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
}

/** Images that the editor handles inline; SVG and other formats become attachments. */
function isEditableImage(file: File): boolean {
  const type = file.type.toLowerCase()
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/gif' || type === 'image/webp') {
    return true
  }
  return /\.(png|jpe?g|gif|webp)$/i.test(file.name)
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function normalizeImageFile(file: File): File {
  if (file.type) return file
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1].toLowerCase() ?? ''
  const type = IMAGE_MIME_BY_EXT[ext]
  return type ? new File([file], file.name, { type }) : file
}

async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    throw new Error('只支持 PNG / JPEG / GIF / WebP 截图')
  }
  if (file.size > MAX_SOURCE) {
    throw new Error('图片超过 25MB，请先裁剪')
  }
  if (file.type === 'image/gif') {
    if (file.size > MAX_UPLOAD) throw new Error('GIF 超过 10MB，请先裁剪')
    const bitmap = await createImageBitmap(file).catch(() => null)
    const width = bitmap?.width ?? null
    const height = bitmap?.height ?? null
    bitmap?.close()
    return { file, width, height }
  }

  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) {
    if (file.size > MAX_UPLOAD) throw new Error('图片超过 10MB，请先裁剪')
    return { file, width: null, height: null }
  }

  const width = bitmap.width
  const height = bitmap.height
  const needsResize = width > MAX_WIDTH || width * height > MAX_PIXELS
  if (!needsResize && file.size <= MAX_UPLOAD) {
    bitmap.close()
    return { file, width, height }
  }

  const scale = Math.min(1, MAX_WIDTH / width, Math.sqrt(MAX_PIXELS / (width * height)))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('浏览器不支持图片处理')
  }
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)
  bitmap.close()

  const preferred = file.type === 'image/png' ? 'image/png' : 'image/webp'
  let blob = await canvasToBlob(canvas, preferred, 0.92)
  if (blob && blob.size > MAX_UPLOAD) {
    blob = await canvasToBlob(canvas, 'image/webp', 0.9)
  }
  if (!blob) throw new Error('图片处理失败')
  if (blob.size > MAX_UPLOAD) throw new Error('压缩后仍超过 10MB，请裁剪截图')

  const ext = blob.type === 'image/webp' ? 'webp' : 'png'
  return {
    file: new File([blob], `screenshot.${ext}`, { type: blob.type }),
    width: targetWidth,
    height: targetHeight,
  }
}

async function dataUrlToFile(src: string): Promise<File> {
  const response = await fetch(src)
  const blob = await response.blob()
  const ext = blob.type.split('/')[1] || 'png'
  return new File([blob], `pasted.${ext}`, { type: blob.type })
}

function rtfGroupEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Browsers don't expose file:// images to a web page. Some editors (WPS/Word)
 * still put the real image into the RTF flavor, so use that as a fallback when
 * the HTML only contains a local path.
 */
function extractRtfImages(rtf: string): File[] {
  if (!rtf || !/\\pict/.test(rtf)) return []
  const files: File[] = []
  let cursor = 0

  while (cursor < rtf.length && files.length < 30) {
    const pict = rtf.indexOf('\\pict', cursor)
    if (pict < 0) break
    const start = rtf.lastIndexOf('{', pict)
    if (start < 0) break
    const end = rtfGroupEnd(rtf, start)
    if (end < 0) break
    const group = rtf.slice(start, end + 1)
    const lower = group.toLowerCase()

    let kind: 'png' | 'jpeg' | null = null
    let signature = ''
    if (lower.includes('\\pngblip')) {
      kind = 'png'
      signature = '89504e47'
    } else if (lower.includes('\\jpegblip')) {
      kind = 'jpeg'
      signature = 'ffd8ff'
    }

    if (kind) {
      const marker = lower.indexOf(kind === 'png' ? '\\pngblip' : '\\jpegblip')
      let p = lower.indexOf(signature, marker)
      let hex = ''
      while (p >= 0 && p < group.length) {
        const ch = group[p]
        if (/[0-9a-fA-F]/.test(ch)) {
          hex += ch
          p++
        } else if (/\s/.test(ch)) {
          p++
        } else {
          break
        }
      }

      if (hex.length >= 100 && hex.length % 2 === 0) {
        const bytes = new Uint8Array(hex.length / 2)
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
        }
        files.push(
          new File([bytes], `rtf-image-${files.length + 1}.${kind === 'png' ? 'png' : 'jpg'}`, {
            type: kind === 'png' ? 'image/png' : 'image/jpeg',
          }),
        )
      }
    }

    cursor = end + 1
  }

  return files
}

function sortImageFiles(files: File[]): File[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  )
}

/**
 * Word puts a lot of Office-only markup and namespaces into text/html. Keep the
 * readable structure, turn v:imagedata into a normal img, and drop the rest.
 */
function cleanPastedHtml(html: string): Document {
  // Word's "HTML Format" sometimes includes MIME headers before <html>. Strip
  // them so they don't become literal text at the top of the document.
  const htmlStart = html.search(/<html[\s>]/i)
  const source = htmlStart > 0 ? html.slice(htmlStart) : html
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  parsed.querySelectorAll('style, link, meta, title, script').forEach((node) => node.remove())

  const comments: Comment[] = []
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_COMMENT)
  while (walker.nextNode()) comments.push(walker.currentNode as Comment)
  comments.forEach((node) => node.remove())

  const elements = Array.from(parsed.body.querySelectorAll('*'))
  for (const element of elements) {
    const tag = element.tagName.toLowerCase()

    if (tag === 'v:imagedata') {
      const image = parsed.createElement('img')
      for (const attribute of ['src', 'width', 'height', 'alt']) {
        const value = element.getAttribute(attribute)
        if (value) image.setAttribute(attribute, value)
      }
      element.replaceWith(image)
      continue
    }

    // Word/Office namespace wrappers (o:p, v:shape, w:...) are not understood by
    // the editor. Unwrap them so their text/images survive instead of being lost.
    if (tag.includes(':') && tag !== 'img' && tag !== 'br') {
      element.replaceWith(...Array.from(element.childNodes))
    }
  }

  // Word heading paragraphs are styled with classes, not h1/h2/h3 tags.
  for (const paragraph of Array.from(parsed.body.querySelectorAll('p'))) {
    const className = paragraph.getAttribute('class') || ''
    const match = className.match(/MsoHeading([1-6])/i)
    if (!match) continue
    const heading = parsed.createElement(`h${match[1]}`)
    heading.innerHTML = paragraph.innerHTML
    paragraph.replaceWith(heading)
  }

  return parsed
}

function isLocalOrInlineImage(src: string): boolean {
  return /^(data:|blob:|file:|cid:)/i.test(src) || src === ''
}

function imageInsertPosition(editor: Editor, fallback?: number): number {
  const requested = fallback ?? editor.state.selection.from
  const docSize = editor.state.doc.content.size
  const pos = Math.max(1, Math.min(requested, docSize))
  const resolved = editor.state.doc.resolve(pos)
  for (let depth = resolved.depth; depth > 0; depth--) {
    if (resolved.node(depth).type.name === 'codeBlock') {
      return resolved.after(depth)
    }
  }
  return pos
}

function insertImageNode(
  editor: Editor,
  attrs: { src: string; alt: string },
  position?: number,
): void {
  const pos = imageInsertPosition(editor, position)
  editor.chain().focus().insertContentAt(pos, { type: 'image', attrs }).run()
}

function insertAttachmentNode(editor: Editor, attrs: AttachmentAttrs, position?: number): void {
  const pos = imageInsertPosition(editor, position)
  editor.chain().focus().insertContentAt(pos, { type: 'attachment', attrs }).run()
}

export default function CollaborativeEditor({
  docId,
  ydoc,
  provider,
  user,
  readOnly,
  onEditor,
  onContentChange,
  onImageClick,
  onError,
  registerUpload,
}: Props) {
  const editorRef = useRef<Editor | null>(null)
  const [uploading, setUploading] = useState(0)

  const uploadImage = useCallback(
    async (file: File) => {
      const prepared = await prepareImage(normalizeImageFile(file))
      return uploadAsset(docId, prepared.file, prepared.width, prepared.height)
    },
    [docId],
  )

  const uploadAttachmentFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_ATTACHMENT) {
        throw new Error(`附件「${file.name || '未命名'}」超过 50MB`)
      }
      if (file.size === 0) {
        throw new Error(`附件「${file.name || '未命名'}」是空文件`)
      }
      return uploadAttachment(docId, file)
    },
    [docId],
  )

  const uploadOne = useCallback(
    async (file: File, position?: number) => {
      const editor = editorRef.current
      if (!editor) return

      if (isEditableImage(file)) {
        const saved = await uploadImage(file)
        insertImageNode(
          editor,
          {
            src: saved.url,
            alt: file.name.replace(/\.[^.]+$/, '') || '截图',
          },
          position,
        )
        return
      }

      const saved = await uploadAttachmentFile(file)
      insertAttachmentNode(
        editor,
        {
          url: saved.url,
          name: file.name || saved.name,
          size: saved.size,
          mime: saved.mime,
          ext: saved.ext || fileExtension(file.name),
        },
        position,
      )
    },
    [uploadAttachmentFile, uploadImage],
  )

  const uploadFiles = useCallback(
    async (files: File[], position?: number) => {
      if (!files.length) return
      setUploading((count) => count + files.length)
      let firstError: string | null = null
      try {
        for (const file of files) {
          try {
            await uploadOne(file, position)
          } catch (error) {
            if (!firstError) {
              firstError = error instanceof Error ? error.message : '文件上传失败'
            }
          }
        }
      } finally {
        setUploading((count) => Math.max(0, count - files.length))
      }
      if (firstError) onError(firstError)
    },
    [onError, uploadOne],
  )

  const importHtmlWithImages = useCallback(
    async (html: string, files: File[], rtfImages: File[] = []): Promise<void> => {
      const parsed = cleanPastedHtml(html)
      const images = Array.from(parsed.querySelectorAll('img'))
      const fileQueue = sortImageFiles(files)
      const rtfQueue = [...rtfImages]
      const uploadedBySource = new Map<string, string>()
      let missing = 0

      const takeFallback = (): File | undefined => fileQueue.shift() ?? rtfQueue.shift()

      setUploading((count) => count + 1)
      try {
        for (const image of images) {
          const src = image.getAttribute('src') || ''
          if (/^https?:/i.test(src)) continue

          if (uploadedBySource.has(src)) {
            image.setAttribute('src', uploadedBySource.get(src)!)
            continue
          }

          let file: File | undefined
          if (/^(data:|blob:)/i.test(src)) {
            try {
              file = await dataUrlToFile(src)
            } catch {
              file = takeFallback()
            }
          } else if (isLocalOrInlineImage(src)) {
            file = takeFallback()
          } else {
            file = takeFallback()
          }

          if (!file) {
            image.remove()
            missing++
            continue
          }

          try {
            const saved = await uploadImage(file)
            image.setAttribute('src', saved.url)
            image.removeAttribute('srcset')
            image.setAttribute('alt', image.getAttribute('alt') || file.name.replace(/\.[^.]+$/, '') || '图片')
            if (!image.getAttribute('width') && saved.width) {
              image.setAttribute('width', String(saved.width))
            }
            if (!image.getAttribute('height') && saved.height) {
              image.setAttribute('height', String(saved.height))
            }
            uploadedBySource.set(src, saved.url)
          } catch (error) {
            image.remove()
            missing++
            onError(error instanceof Error ? error.message : '图片上传失败')
          }
        }

        // Clipboard formats sometimes keep the images as separate files without
        // an <img> placeholder. Preserve them at the end instead of dropping them.
        const remaining = [...fileQueue, ...(images.length === 0 ? rtfQueue : [])]
        if (remaining.length) {
          const wrapper = parsed.createElement('p')
          for (const file of remaining) {
            try {
              const saved = await uploadImage(file)
              const image = parsed.createElement('img')
              image.setAttribute('src', saved.url)
              image.setAttribute('alt', file.name.replace(/\.[^.]+$/, '') || '图片')
              if (saved.width) image.setAttribute('width', String(saved.width))
              if (saved.height) image.setAttribute('height', String(saved.height))
              wrapper.appendChild(image)
            } catch (error) {
              missing++
              onError(error instanceof Error ? error.message : '图片上传失败')
            }
          }
          if (wrapper.childNodes.length) parsed.body.appendChild(wrapper)
        }

        const editor = editorRef.current
        const content = parsed.body.innerHTML
        if (content.trim()) {
          try {
            editor?.chain().focus().insertContent(content).run()
          } catch (error) {
            onError(error instanceof Error ? error.message : '粘贴内容失败')
          }
        }
        if (missing) {
          onError(`有 ${missing} 张图片未能读取，可以单独截图后粘贴`)
        }
      } finally {
        setUploading((count) => Math.max(0, count - 1))
      }
    },
    [onError, uploadImage],
  )

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          undoRedo: false,
          codeBlock: false,
          heading: { levels: [1, 2, 3] },
          link: {
            openOnClick: false,
            autolink: true,
            linkOnPaste: true,
            HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
            isAllowedUri: (url) => /^(https?:\/\/|mailto:)/i.test(url),
          },
        }),
        Collaboration.configure({ document: ydoc, field: 'content' }),
        CollaborationCaret.configure({
          provider,
          user: { name: user.name, color: user.color },
        }),
        Image.configure({
          inline: false,
          allowBase64: false,
          HTMLAttributes: { class: 'doc-image' },
        }),
        Attachment,
        CodeBlockLowlight.configure({ lowlight }),
        Placeholder.configure({
          placeholder: '把题目描述、代码、截图、附件放在这里……',
        }),
      ],
      editable: !readOnly,
      editorProps: {
        attributes: {
          class: 'lanpad-editor',
          spellcheck: 'false',
        },
        handlePaste: (_view, event) => {
          if (readOnly) return false
          const clipboard = event.clipboardData
          const html = clipboard?.getData('text/html') || ''
          const rtf = clipboard?.getData('text/rtf') || ''
          const allFiles = filesFromTransfer(clipboard)
          const imageFiles = allFiles.filter(isEditableImage)
          const attachmentFiles = allFiles.filter((file) => !isEditableImage(file))
          const hasEmbeddedImage =
            /<img[^>]+src=["'](data:|blob:|file:|cid:)/i.test(html) || /<v:imagedata/i.test(html)
          const hasImageTag = /<img[\s>]/i.test(html)
          const imageCount = (html.match(/<img[\s>]/gi) ?? []).length
          const hasFilePlaceholder =
            /<img[^>]+src=["'](file:|cid:|\s*["'])/i.test(html) || /<v:imagedata/i.test(html)
          const shouldUseRtf = Boolean(
            rtf && (hasFilePlaceholder || (!hasImageTag && imageFiles.length === 0)),
          )
          const rtfImages =
            shouldUseRtf && imageFiles.length < Math.max(1, imageCount)
              ? extractRtfImages(rtf)
              : []
          const needsHtmlImport = Boolean(
            html &&
              (hasEmbeddedImage ||
                (imageFiles.length > 0 && !hasImageTag) ||
                rtfImages.length > 0),
          )

          if (attachmentFiles.length) {
            event.preventDefault()
            void (async () => {
              if (needsHtmlImport) {
                await importHtmlWithImages(html, imageFiles, rtfImages)
                await uploadFiles(attachmentFiles)
                return
              }
              await uploadFiles([...imageFiles, ...attachmentFiles])
            })()
            return true
          }

          if (needsHtmlImport) {
            event.preventDefault()
            void importHtmlWithImages(html, imageFiles, rtfImages)
            return true
          }

          if (imageFiles.length) {
            event.preventDefault()
            void uploadFiles(imageFiles)
            return true
          }

          return false
        },
        handleDrop: (view, event, _slice, moved) => {
          if (readOnly || moved) return false
          const files = filesFromTransfer(event.dataTransfer)
          if (!files.length) return false
          event.preventDefault()
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
          void uploadFiles(files, coords?.pos)
          return true
        },
      },
      onCreate: ({ editor: instance }) => {
        editorRef.current = instance
        onEditor(instance)
        provider.awareness.setLocalStateField('user', { name: user.name, color: user.color })
      },
      onDestroy: () => {
        editorRef.current = null
        onEditor(null)
      },
      onUpdate: ({ editor: instance }) => {
        onContentChange(instance.getText().length)
      },
    },
    [provider, ydoc],
  )

  useEffect(() => {
    registerUpload(uploadFiles)
    return () => registerUpload(null)
  }, [registerUpload, uploadFiles])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!readOnly)
  }, [editor, readOnly])

  useEffect(() => {
    if (!editor) return
    editor.commands.updateUser({ name: user.name, color: user.color })
    provider.awareness.setLocalStateField('user', { name: user.name, color: user.color })
  }, [editor, provider, user.name, user.color])

  return (
    <div className="editor-shell" onClick={(event) => {
      const target = event.target as HTMLElement
      if (target.tagName === 'IMG') {
        onImageClick(target.getAttribute('src') || '')
      }
    }}>
      <EditorContent editor={editor} />
      {uploading > 0 ? <div className="upload-badge">正在上传文件…</div> : null}
    </div>
  )
}
