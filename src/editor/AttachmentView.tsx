import type { MouseEvent } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import FileIcon from '../components/FileIcon'
import { fileExtension, formatFileSize } from '../files'

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2.2 12s3.5-6 9.8-6 9.8 6 9.8 6-3.5 6-9.8 6-9.8-6-9.8-6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function AttachmentView({ node, selected }: NodeViewProps) {
  const attrs = node.attrs as {
    url?: string
    name?: string
    size?: number
    mime?: string
    ext?: string
  }
  const url = attrs.url || ''
  const name = attrs.name || '附件'
  const size = Number(attrs.size || 0)
  const mime = attrs.mime || ''
  const ext = attrs.ext || fileExtension(name)

  function preview(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <NodeViewWrapper
      className={`attachment-node${selected ? ' is-selected' : ''}`}
    >
      <div className="attachment-card">
        <FileIcon name={name} mime={mime} />
        <div className="attachment-info">
          <span className="attachment-name" title={name}>
            {name}
          </span>
          <span className="attachment-sub">
            {formatFileSize(size)}
            {ext ? ` · ${ext.toUpperCase()}` : ''}
          </span>
        </div>
        <div className="attachment-actions" contentEditable={false}>
          <button
            type="button"
            className="attachment-action"
            onClick={preview}
            title="预览 / 打开"
            aria-label="预览附件"
          >
            <EyeIcon />
          </button>
          <a
            className="attachment-action"
            href={url ? `${url}?download=1` : undefined}
            download={name}
            title="下载附件"
            aria-label="下载附件"
            onClick={(event) => event.stopPropagation()}
          >
            <DownloadIcon />
          </a>
        </div>
      </div>
    </NodeViewWrapper>
  )
}
