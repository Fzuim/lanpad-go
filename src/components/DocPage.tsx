import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { getDoc, getNetwork } from '../api'
import { exportDocument } from '../exportDocument'
import type { PMNode } from '../history'
import type { DocMeta, NetworkInfo, PresenceUser, UserInfo } from '../types'
import {
  chooseBase,
  makeWsUrl,
  pickColor,
  randomName,
  replaceYText,
  sanitizeName,
} from '../utils'
import NameDialog from './NameDialog'
import ShareDialog from './ShareDialog'
import HistoryDialog from './HistoryDialog'
import Presence from './Presence'
import Toolbar from './Toolbar'
import CollaborativeEditor from './CollaborativeEditor'

type Props = {
  docId: string
  onBack: () => void
}

type StoredUser = {
  user: UserInfo
  hasStoredName: boolean
}

function loadUser(): StoredUser {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = sanitizeName(params.get('name') || '')
  const stored = sanitizeName(localStorage.getItem('lanpad.name') || '')
  const storedColor = localStorage.getItem('lanpad.color') || ''
  const color = /^#[0-9a-f]{6}$/i.test(storedColor) ? storedColor : pickColor()
  return {
    user: {
      name: fromUrl || stored || randomName(),
      color,
    },
    hasStoredName: Boolean(fromUrl || stored),
  }
}

export default function DocPage({ docId, onBack }: Props) {
  const storedUser = useRef<StoredUser>(loadUser())
  const [user, setUser] = useState<UserInfo>(storedUser.current.user)
  const [showName, setShowName] = useState(!storedUser.current.hasStoredName)

  const [ydoc] = useState(() => new Y.Doc())
  const [provider, setProvider] = useState<WebsocketProvider | null>(null)
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [network, setNetwork] = useState<NetworkInfo | null>(null)
  const [loadError, setLoadError] = useState('')
  const [status, setStatus] = useState('connecting')
  const [synced, setSynced] = useState(false)
  const [presence, setPresence] = useState<PresenceUser[]>([])
  const [title, setTitle] = useState('')
  const [chars, setChars] = useState(0)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [showShare, setShowShare] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [toast, setToast] = useState('')
  const [lightbox, setLightbox] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<((files: File[]) => Promise<void>) | null>(null)
  const toastTimer = useRef<number | null>(null)
  const titleInitialized = useRef(false)

  const readOnly = new URLSearchParams(window.location.search).get('mode') === 'view'

  const notify = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3200)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  useEffect(() => {
    if (storedUser.current.hasStoredName) {
      localStorage.setItem('lanpad.name', user.name)
      localStorage.setItem('lanpad.color', user.color)
    }
    // Only persist the initial URL/stored name once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    getNetwork().then(setNetwork).catch(() => undefined)
    getDoc(docId)
      .then((value) => {
        setMeta(value)
        setTitle(value.title)
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : '文档加载失败')
      })
  }, [docId])

  useEffect(() => {
    if (!meta) return

    const next = new WebsocketProvider(makeWsUrl(docId), docId, ydoc, {
      params: {
        user: user.name,
        mode: readOnly ? 'view' : 'edit',
      },
    })
    next.on('status', ({ status: nextStatus }: { status: string }) => setStatus(nextStatus))
    next.on('sync', (isSynced: boolean) => setSynced(isSynced))

    setProvider(next)
    const awareness = next.awareness
    if (!awareness) {
      return () => next.destroy()
    }

    const updatePresence = () => {
      const users: PresenceUser[] = []
      for (const [clientId, state] of awareness.getStates()) {
        const info = state.user as { name?: unknown; color?: unknown } | undefined
        if (!info || typeof info.name !== 'string' || !info.name.trim()) continue
        users.push({
          clientId,
          name: info.name.trim().slice(0, 24),
          color: typeof info.color === 'string' ? info.color : pickColor(),
          isSelf: clientId === awareness.clientID,
        })
      }
      users.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name, 'zh-CN'))
      setPresence(users)
    }

    awareness.on('change', updatePresence)
    updatePresence()

    return () => {
      awareness.off('change', updatePresence)
      next.destroy()
      setProvider(null)
      setPresence([])
    }
  }, [docId, meta, ydoc])

  useEffect(() => {
    if (!provider) return
    provider.awareness.setLocalStateField('user', { name: user.name, color: user.color })
  }, [provider, user.name, user.color])

  useEffect(() => {
    const yTitle = ydoc.getText('title')
    const sync = () => setTitle(yTitle.toString())
    yTitle.observe(sync)
    sync()
    return () => yTitle.unobserve(sync)
  }, [ydoc])

  useEffect(() => {
    if (!synced || titleInitialized.current) return
    titleInitialized.current = true
    const yTitle = ydoc.getText('title')
    if (!yTitle.toString() && meta?.title) {
      yTitle.insert(0, meta.title)
    }
  }, [synced, meta, ydoc])

  useEffect(() => {
    document.title = `${title || '未命名文档'} · LAN Pad`
  }, [title])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLightbox('')
        setShowShare(false)
        setShowHistory(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const registerUpload = useCallback((upload: ((files: File[]) => Promise<void>) | null) => {
    uploadRef.current = upload
  }, [])

  const handleEditor = useCallback((instance: Editor | null) => {
    setEditor(instance)
    if (instance) setChars(instance.getText().length)
  }, [])

  const handleTitleChange = (value: string) => {
    const next = value.replace(/[\r\n]/g, ' ').slice(0, 120)
    setTitle(next)
    replaceYText(ydoc.getText('title'), next)
  }

  const handleSaveName = (name: string) => {
    setUser((current) => ({ ...current, name }))
    localStorage.setItem('lanpad.name', name)
    localStorage.setItem('lanpad.color', user.color)
    setShowName(false)
    if (editor) editor.commands.updateUser({ name, color: user.color })
  }

  const handleFiles = (files: File[]) => {
    if (!files.length) return
    if (!uploadRef.current) {
      notify('编辑器还没准备好，请稍后重试')
      return
    }
    void uploadRef.current(files)
  }

  const handleExport = async () => {
    if (!editor) {
      notify('编辑器还没准备好，请稍后重试')
      return
    }
    if (exporting) return
    setExporting(true)
    setExportProgress('')
    try {
      await exportDocument({
        title: title || '未命名文档',
        json: editor.getJSON() as unknown as PMNode,
        onProgress: (done, total) => setExportProgress(total ? `${done}/${total}` : ''),
      })
      notify('已导出 ZIP 压缩包')
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExporting(false)
      setExportProgress('')
    }
  }

  const shareBase = meta?.url
    ? meta.url.replace(/\/d\/[0-9a-z]{12}$/, '')
    : chooseBase(network)
  const shareLink = `${shareBase}/d/${docId}`

  if (loadError) {
    return (
      <main className="error-page">
        <div className="error-card">
          <div className="brand-mark">LAN Pad</div>
          <h1>打不开这个文档</h1>
          <p>{loadError}</p>
          <button type="button" className="btn btn-primary" onClick={onBack}>
            返回首页
          </button>
        </div>
      </main>
    )
  }

  return (
    <div className="doc-page">
      <header className="doc-header">
        <button type="button" className="icon-btn back-btn" onClick={onBack} title="返回首页">
          ←
        </button>
        <input
          className="doc-title"
          value={title}
          placeholder="未命名文档"
          maxLength={120}
          readOnly={readOnly}
          onChange={(event) => handleTitleChange(event.target.value)}
          aria-label="文档标题"
        />
        <div className="doc-header-right">
          {readOnly ? <span className="readonly-badge">只读</span> : null}
          <span className={`conn-status conn-${status}`}>
            <i />
            {status === 'connected' ? (synced ? '已同步' : '同步中') : status === 'disconnected' ? '重连中' : '连接中'}
          </span>
          <Presence users={presence} />
          <button type="button" className="btn btn-ghost hide-small" onClick={() => setShowName(true)}>
            改名
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShowHistory(true)}
            disabled={!editor || !synced}
          >
            历史
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void handleExport()}
            disabled={!editor || exporting}
            title="导出为 ZIP（Markdown + 图片/附件）"
          >
            {exporting ? (exportProgress ? `导出 ${exportProgress}` : '导出中…') : '导出'}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setShowShare(true)}>
            分享
          </button>
        </div>
      </header>

      {readOnly ? (
        <div className="readonly-banner">只读查看模式；把链接里的 <code>?mode=view</code> 去掉即可编辑。</div>
      ) : (
        <Toolbar
          editor={editor}
          onPickImage={() => fileInputRef.current?.click()}
          onPickAttachment={() => attachmentInputRef.current?.click()}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          handleFiles(files)
        }}
      />

      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="attachment-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          handleFiles(files)
        }}
      />

      <main className="doc-main">
        {!meta || !provider ? (
          <div className="doc-loading">
            <div className="spinner" />
            <span>正在打开文档…</span>
          </div>
        ) : (
          <CollaborativeEditor
            docId={docId}
            ydoc={ydoc}
            provider={provider}
            user={user}
            readOnly={readOnly}
            onEditor={handleEditor}
            onContentChange={setChars}
            onImageClick={setLightbox}
            onError={notify}
            registerUpload={registerUpload}
          />
        )}
      </main>

      <footer className="doc-footer">
        <span>{chars.toLocaleString('zh-CN')} 字</span>
        <span className="dot">·</span>
        <span>{synced ? '已自动保存' : '正在同步'}</span>
        <span className="footer-tip">Ctrl/⌘+V 可直接粘贴截图</span>
      </footer>

      {showName ? <NameDialog initialName={user.name} onSave={handleSaveName} /> : null}
      {showShare ? <ShareDialog link={shareLink} onClose={() => setShowShare(false)} /> : null}
      {showHistory ? (
        <HistoryDialog
          docId={docId}
          editor={editor}
          ydoc={ydoc}
          readOnly={readOnly}
          synced={synced}
          onClose={() => setShowHistory(false)}
          onRestored={notify}
          onError={notify}
        />
      ) : null}
      {lightbox ? (
        <div className="lightbox" onClick={() => setLightbox('')} role="dialog" aria-label="查看截图">
          <img src={lightbox} alt="截图预览" onClick={(event) => event.stopPropagation()} />
          <button type="button" className="lightbox-close" onClick={() => setLightbox('')}>
            ×
          </button>
        </div>
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
