import { Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import AttachmentView from './AttachmentView'

export type AttachmentAttrs = {
  url: string
  name: string
  size: number
  mime: string
  ext: string
}

/**
 * A block-level file card. The file lives in /assets; the node only stores
 * the URL, display name, size and MIME type, so it syncs through Yjs like an
 * image node does.
 */
export const Attachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      url: { default: '' },
      name: { default: '附件' },
      size: { default: 0 },
      mime: { default: 'application/octet-stream' },
      ext: { default: '' },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-attachment]',
        getAttrs: (element) => {
          const el = element as HTMLElement
          return {
            url: el.getAttribute('data-url') || '',
            name: el.getAttribute('data-name') || '附件',
            size: Number(el.getAttribute('data-size') || 0),
            mime: el.getAttribute('data-mime') || 'application/octet-stream',
            ext: el.getAttribute('data-ext') || '',
          }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as AttachmentAttrs
    return [
      'div',
      {
        'data-attachment': '',
        'data-url': attrs.url || '',
        'data-name': attrs.name || '附件',
        'data-size': String(attrs.size ?? 0),
        'data-mime': attrs.mime || '',
        'data-ext': attrs.ext || '',
      },
      [
        'a',
        { href: attrs.url || '', target: '_blank', rel: 'noopener noreferrer' },
        attrs.name || '附件',
      ],
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView)
  },
})
