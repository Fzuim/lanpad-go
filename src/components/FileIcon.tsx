import {
  FILE_CATEGORY_META,
  fileCategory,
  fileExtension,
  type FileCategory,
} from '../files'

type Props = {
  name: string
  mime?: string
  className?: string
}

function iconLabel(category: FileCategory, extension: string): string {
  if (extension && extension.length <= 4) return extension.toUpperCase()
  return FILE_CATEGORY_META[category].short
}

export default function FileIcon({ name, mime = '', className = '' }: Props) {
  const category = fileCategory(name, mime)
  const meta = FILE_CATEGORY_META[category]
  const label = iconLabel(category, fileExtension(name))

  return (
    <span
      className={`file-icon file-icon-${category} ${className}`.trim()}
      style={{ color: meta.color }}
      aria-label={meta.label}
      title={meta.label}
    >
      <svg className="file-icon-shape" viewBox="0 0 40 48" aria-hidden="true">
        <path d="M5 1h20l10 10v35a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" fill="currentColor" />
        <path d="M25 1v9a1 1 0 0 0 1 1h9z" fill="rgba(255,255,255,0.38)" />
        <path
          d="M10 33h20"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="file-icon-label">{label}</span>
    </span>
  )
}
