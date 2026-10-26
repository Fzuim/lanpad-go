export type FileCategory =
  | 'archive'
  | 'pdf'
  | 'word'
  | 'excel'
  | 'ppt'
  | 'image'
  | 'audio'
  | 'video'
  | 'code'
  | 'text'
  | 'other'

const CATEGORY_BY_EXTENSION: Record<string, FileCategory> = {
  rar: 'archive',
  zip: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  rtf: 'word',
  odt: 'word',
  xls: 'excel',
  xlsx: 'excel',
  csv: 'excel',
  ods: 'excel',
  ppt: 'ppt',
  pptx: 'ppt',
  odp: 'ppt',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  ico: 'image',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  py: 'code',
  go: 'code',
  c: 'code',
  cc: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  java: 'code',
  rs: 'code',
  rb: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  sql: 'code',
  html: 'code',
  css: 'code',
  json: 'code',
  xml: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  ini: 'code',
  txt: 'text',
  md: 'text',
  log: 'text',
  conf: 'text',
}

export const FILE_CATEGORY_META: Record<
  FileCategory,
  { label: string; color: string; short: string }
> = {
  archive: { label: '压缩包', color: '#7c3aed', short: 'ZIP' },
  pdf: { label: 'PDF', color: '#dc2626', short: 'PDF' },
  word: { label: 'Word', color: '#2563eb', short: 'DOC' },
  excel: { label: '表格', color: '#059669', short: 'XLS' },
  ppt: { label: '演示文稿', color: '#ea580c', short: 'PPT' },
  image: { label: '图片', color: '#0891b2', short: 'IMG' },
  audio: { label: '音频', color: '#db2777', short: 'MP3' },
  video: { label: '视频', color: '#4f46e5', short: 'MP4' },
  code: { label: '代码', color: '#0f766e', short: 'CODE' },
  text: { label: '文本', color: '#64748b', short: 'TXT' },
  other: { label: '文件', color: '#64748b', short: 'FILE' },
}

export function fileExtension(name: string): string {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name.trim())
  return match ? match[1].toLowerCase() : ''
}

export function fileCategory(name: string, mime = ''): FileCategory {
  const ext = fileExtension(name)
  if (ext && CATEGORY_BY_EXTENSION[ext]) return CATEGORY_BY_EXTENSION[ext]

  const base = mime.toLowerCase().split(';')[0]
  if (base.startsWith('image/')) return 'image'
  if (base.startsWith('audio/')) return 'audio'
  if (base.startsWith('video/')) return 'video'
  if (base === 'application/pdf') return 'pdf'
  if (base.includes('word')) return 'word'
  if (base.includes('sheet') || base.includes('excel')) return 'excel'
  if (base.includes('presentation') || base.includes('powerpoint')) return 'ppt'
  if (base.startsWith('text/')) return 'text'
  if (base.includes('zip') || base.includes('rar') || base.includes('7z')) return 'archive'
  return 'other'
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
