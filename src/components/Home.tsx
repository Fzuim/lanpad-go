import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, createDoc, deleteDoc, getDocs, getNetwork } from '../api'
import type { DocMeta, NetworkInfo } from '../types'
import { chooseBase, copyText, formatRelative } from '../utils'

type Props = {
  onOpen: (id: string) => void
}

const HOST_KEY_STORAGE = 'lanpad.hostKey'

function initialBase(network: NetworkInfo): string {
  const stored = localStorage.getItem('lanpad.base')
  if (stored && network.addresses.some((item) => item.url === stored)) return stored
  return chooseBase(network)
}

export default function Home({ onOpen }: Props) {
  const [network, setNetwork] = useState<NetworkInfo | null>(null)
  const [base, setBase] = useState('')
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [copied, setCopied] = useState('')
  const noticeTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    }
  }, [])

  const refresh = useCallback(async (nextBase?: string) => {
    try {
      setError('')
      const net = await getNetwork()
      setNetwork(net)
      const resolvedBase = nextBase || base || initialBase(net)
      setBase(resolvedBase)
      const result = await getDocs(resolvedBase)
      setDocs(result.docs)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  async function handleCreate() {
    if (busy) return
    setBusy(true)
    try {
      const doc = await createDoc()
      onOpen(doc.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建失败')
      setBusy(false)
    }
  }

  async function handleCopy(text: string, key: string) {
    const ok = await copyText(text)
    if (!ok) {
      setError('浏览器没有允许自动复制，请手动选中链接复制。')
      return
    }
    setCopied(key)
    window.setTimeout(() => setCopied(''), 1600)
  }

  function handleBaseChange(value: string) {
    setBase(value)
    localStorage.setItem('lanpad.base', value)
    void refresh(value)
  }

  function flashNotice(message: string) {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2600)
  }

  async function handleDelete(doc: DocMeta) {
    if (deleting) return
    const detail = doc.online > 0 ? `\n当前有 ${doc.online} 人在编辑，删除后他们会断开。` : ''
    if (!window.confirm(`确定删除「${doc.title || '未命名文档'}」？${detail}\n删除后首页不再显示。`)) {
      return
    }

    let key = sessionStorage.getItem(HOST_KEY_STORAGE)?.trim() || ''
    if (!key) {
      key =
        window
          .prompt('删除文档需要主机密钥。\n启动服务时控制台会打印，或查看 data/host-key.txt：')
          ?.trim() || ''
      if (!key) return
    }

    setDeleting(doc.id)
    setError('')
    try {
      await deleteDoc(doc.id, key)
      sessionStorage.setItem(HOST_KEY_STORAGE, key)
      setDocs((current) => current.filter((item) => item.id !== doc.id))
      flashNotice(`已删除「${doc.title || '未命名文档'}」`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        sessionStorage.removeItem(HOST_KEY_STORAGE)
        setError('主机密钥不正确，请重试。密钥在 data/host-key.txt 或启动控制台里。')
      } else if (err instanceof ApiError && err.status === 404) {
        setDocs((current) => current.filter((item) => item.id !== doc.id))
        flashNotice('文档已经不存在')
      } else {
        setError(err instanceof Error ? err.message : '删除失败')
      }
    } finally {
      setDeleting('')
    }
  }

  const isLocalhost = base.includes('127.0.0.1') || base.includes('localhost')

  return (
    <div className="home">
      <header className="home-header">
        <div className="brand">
          <div className="brand-mark">LP</div>
          <div>
            <div className="brand-name">LAN Pad</div>
            <div className="brand-sub">队内题目协作 · 文字 / 代码 / 截图</div>
          </div>
        </div>
        <div className="network-box">
          <span className="network-label">本机局域网地址</span>
          {network && network.addresses.length > 1 ? (
            <select
              className="address-select"
              value={base}
              onChange={(event) => handleBaseChange(event.target.value)}
            >
              {network.addresses.map((item) => (
                <option key={item.address} value={item.url}>
                  {item.address} · {item.iface}
                </option>
              ))}
            </select>
          ) : (
            <code className="network-url">{base || '检测中…'}</code>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={!base}
            onClick={() => void handleCopy(base, 'root')}
          >
            {copied === 'root' ? '已复制' : '复制'}
          </button>
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <div>
            <h1>把题目放到一个链接里</h1>
            <p>新建文档，复制带本机 IP 的链接发到群里；队友打开就能一起写。</p>
          </div>
          <button type="button" className="btn btn-primary btn-large" disabled={busy} onClick={handleCreate}>
            {busy ? '正在创建…' : '+ 新建文档'}
          </button>
        </section>

        {isLocalhost ? (
          <div className="notice notice-warn">
            当前复制出的地址是 localhost，队友打不开。请在上方选择
            <code>192.168.x.x</code> 或 <code>10.x.x.x</code> 的网卡地址。
          </div>
        ) : null}

        {error ? <div className="notice notice-error">{error}</div> : null}
        {notice ? <div className="notice notice-success">{notice}</div> : null}

        <section className="doc-section">
          <div className="section-head">
            <h2>文档</h2>
            <span>{docs.length} 个</span>
          </div>

          {loading ? (
            <div className="empty-state">
              <div className="spinner" />
              <span>正在加载…</span>
            </div>
          ) : docs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">＋</div>
              <h3>还没有文档</h3>
              <p>点“新建文档”，把第一道题放进来。</p>
            </div>
          ) : (
            <div className="doc-grid">
              {docs.map((doc) => {
                const link = `${base}/d/${doc.id}`
                return (
                  <article className="doc-card" key={doc.id}>
                    <button type="button" className="doc-card-main" onClick={() => onOpen(doc.id)}>
                      <div className="doc-card-top">
                        <h3>{doc.title || '未命名文档'}</h3>
                        {doc.online > 0 ? <span className="online-badge">● {doc.online} 人在线</span> : null}
                      </div>
                      <div className="doc-card-meta">
                        {doc.last_editor ? <span>{doc.last_editor}</span> : <span>最近更新</span>}
                        <span>·</span>
                        <span>{formatRelative(doc.updated_at)}</span>
                      </div>
                    </button>
                    <div className="doc-card-actions">
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => onOpen(doc.id)}>
                        打开
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        onClick={() => void handleCopy(link, doc.id)}
                      >
                        {copied === doc.id ? '已复制' : '复制链接'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger-ghost btn-small"
                        disabled={deleting === doc.id}
                        onClick={() => void handleDelete(doc)}
                      >
                        {deleting === doc.id ? '删除中…' : '删除'}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <section className="home-help">
          <div>
            <strong>队友打不开？</strong>
            <span>确认在同一局域网；Windows 防火墙放行 8787 端口；关闭路由器的 AP 隔离。</span>
          </div>
          <div>
            <strong>截图怎么放？</strong>
            <span>在文档里直接 Ctrl/⌘+V 粘贴，或把图片拖进正文；代码建议用代码块。</span>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <span>LAN Pad v0.1</span>
        <span>数据只保存在这台电脑的 data/ 目录</span>
      </footer>
    </div>
  )
}
