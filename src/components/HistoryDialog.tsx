import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type * as Y from 'yjs'
import { getVersion, getVersions, snapshotVersion } from '../api'
import {
  decodeVersionState,
  diffLines,
  formatBytes,
  prosemirrorJSONToText,
  type PMNode,
  type VersionContent,
} from '../history'
import type { DocVersion } from '../types'
import { formatRelative, replaceYText } from '../utils'

type Props = {
  docId: string
  editor: Editor | null
  ydoc: Y.Doc
  readOnly: boolean
  synced: boolean
  onClose: () => void
  onRestored: (message: string) => void
  onError: (message: string) => void
}

const MAX_DIFF_ROWS = 400

export default function HistoryDialog({
  docId,
  editor,
  ydoc,
  readOnly,
  synced,
  onClose,
  onRestored,
  onError,
}: Props) {
  const [versions, setVersions] = useState<DocVersion[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [content, setContent] = useState<VersionContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  const cacheRef = useRef(new Map<number, VersionContent>())
  const requestRef = useRef(0)

  const loadDetail = useCallback(
    async (versionId: number) => {
      setSelectedId(versionId)
      const cached = cacheRef.current.get(versionId)
      if (cached) {
        requestRef.current++
        setContent(cached)
        setDetailLoading(false)
        return
      }

      const request = ++requestRef.current
      setDetailLoading(true)
      setError('')
      try {
        const detail = await getVersion(docId, versionId)
        if (requestRef.current !== request) return
        const decoded = decodeVersionState(detail.state)
        cacheRef.current.set(versionId, decoded)
        setContent(decoded)
      } catch (err) {
        if (requestRef.current !== request) return
        setError(err instanceof Error ? err.message : '版本内容加载失败')
      } finally {
        if (requestRef.current === request) setDetailLoading(false)
      }
    },
    [docId],
  )

  useEffect(() => {
    let cancelled = false
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    getVersions(docId)
      .then((result) => {
        if (cancelled || requestRef.current !== request) return
        setVersions(result.versions)
        setLoading(false)
        if (result.versions[0]) void loadDetail(result.versions[0].id)
      })
      .catch((err: unknown) => {
        if (cancelled || requestRef.current !== request) return
        setError(err instanceof Error ? err.message : '版本列表加载失败')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [docId, loadDetail])

  useEffect(() => {
    if (!editor) return
    const bump = () => setTick((value) => value + 1)
    editor.on('update', bump)
    return () => {
      editor.off('update', bump)
    }
  }, [editor])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const currentText = useMemo(() => {
    if (!editor) return ''
    return prosemirrorJSONToText(editor.getJSON() as PMNode)
    // `tick` is the change signal from the editor subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, tick])

  const diff = useMemo(
    () => (content ? diffLines(content.text, currentText) : []),
    [content, currentText],
  )

  const selected = versions.find((version) => version.id === selectedId) ?? null
  const canRestore = Boolean(editor && content && synced && !readOnly && !restoring)

  async function handleRestore() {
    if (!editor || !content || !canRestore) return
    if (!window.confirm('恢复这个版本会覆盖所有人的当前内容，可以用 Ctrl+Z 撤销。继续？')) return

    setRestoring(true)
    try {
      // Keep the pre-restore state in history as well.
      await snapshotVersion(docId).catch(() => undefined)
      // Apply the content as a normal local editor change so the shared
      // Yjs undo manager records it as one restorable step. Wrapping this
      // in an outer ydoc.transact would hide the y-sync origin from the
      // undo manager and make Ctrl+Z a no-op.
      editor.commands.setContent(content.json, { emitUpdate: true })
      replaceYText(ydoc.getText('title'), content.title || '未命名文档')
      onRestored('已恢复到该版本，可用 Ctrl+Z 撤销')
      onClose()
    } catch (err) {
      onError(err instanceof Error ? err.message : '恢复失败')
    } finally {
      setRestoring(false)
    }
  }

  function handleDownload() {
    if (!content) return
    const title = (selected?.title || content.title || '未命名文档').replace(/[\\/:*?"<>|]/g, '-')
    const body = `# ${title}\n\n${content.text}\n`
    const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${title}-v${selected?.id ?? 'snapshot'}.md`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="modal history-modal" role="dialog" aria-label="版本历史">
        <div className="modal-head">
          <div>
            <div className="modal-kicker">自动保存</div>
            <h2>
              版本历史
              {!loading ? <span className="history-count">共 {versions.length} 个</span> : null}
            </h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="modal-hint">
          编辑过程自动保存快照；选中版本可对比差异或恢复（恢复对所有人生效，且可用 Ctrl+Z 撤销）。
        </p>

        {loading ? (
          <div className="history-loading">
            <div className="spinner" />
            <span>正在读取历史…</span>
          </div>
        ) : error ? (
          <div className="history-error">{error}</div>
        ) : versions.length === 0 ? (
          <div className="history-empty">
            还没有历史快照。开始编辑后，系统会自动记录；最后一个人离开时也会保存一次。
          </div>
        ) : (
          <>
            <div className="history-versions">
              {versions.map((version) => (
                <button
                  key={version.id}
                  type="button"
                  className={`history-card${version.id === selectedId ? ' selected' : ''}`}
                  onClick={() => void loadDetail(version.id)}
                  title={`${version.title || '未命名文档'} · ${new Date(version.created_at).toLocaleString('zh-CN')}`}
                >
                  <span className="history-card-time">{formatRelative(version.created_at)}</span>
                  <span className="history-card-meta">
                    {version.sha256 ? `#${version.sha256.slice(0, 8)}` : '#—'} ·{' '}
                    {formatBytes(version.size)}
                  </span>
                </button>
              ))}
            </div>

            <div className="history-toolbar">
              <div className="history-legend">
                <span className="legend-minus">- 恢复将删除</span>
                <span className="legend-plus">+ 当前独有</span>
              </div>
              <button
                type="button"
                className="icon-btn history-download"
                onClick={handleDownload}
                disabled={!content}
                title="下载此版本文本"
              >
                ↓
              </button>
            </div>

            <div className="history-diff" aria-label="版本差异">
              {detailLoading ? (
                <div className="history-loading">
                  <div className="spinner" />
                  <span>正在加载版本…</span>
                </div>
              ) : diff.length === 0 ? (
                <div className="history-empty">与当前内容一致</div>
              ) : (
                <>
                  {diff.slice(0, MAX_DIFF_ROWS).map((row, index) => (
                    <div
                      key={`${row.kind}-${index}`}
                      className={`history-diff-row ${
                        row.kind === 'add' ? 'added' : row.kind === 'remove' ? 'removed' : 'same'
                      }`}
                    >
                      <span className="history-diff-no">{row.oldLine ?? row.newLine ?? ''}</span>
                      <span className="history-diff-sign">
                        {row.kind === 'remove' ? '-' : row.kind === 'add' ? '+' : ' '}
                      </span>
                      <span className="history-diff-text">{row.text || ' '}</span>
                    </div>
                  ))}
                  {diff.length > MAX_DIFF_ROWS ? (
                    <div className="history-more">
                      差异较长，仅显示前 {MAX_DIFF_ROWS} 行（共 {diff.length} 行）。
                    </div>
                  ) : null}
                </>
              )}
            </div>

            <div className="history-footer">
              <span className="history-note">
                {readOnly
                  ? '只读模式不能恢复版本。'
                  : !synced
                    ? '等待同步完成后才能恢复。'
                    : '恢复会写入当前共享文档，所有在线队友都会看到。'}
              </span>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleRestore()}
                disabled={!canRestore}
              >
                {restoring ? '恢复中…' : '恢复此版本'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
