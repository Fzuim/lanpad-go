import { useState } from 'react'
import { copyText } from '../utils'

type Props = {
  link: string
  onClose: () => void
}

export default function ShareDialog({ link, onClose }: Props) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)

  async function handleCopy() {
    const ok = await copyText(link)
    if (!ok) {
      setCopyError(true)
      return
    }
    setCopyError(false)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal share-modal">
        <div className="modal-head">
          <div>
            <div className="modal-kicker">邀请队友</div>
            <h2>把链接发到群里</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="modal-hint">
          队友必须在同一局域网。链接里已经是本机 IP，不要改成 localhost。
        </p>
        <div className="share-link-row">
          <input className="text-input mono" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="btn btn-primary" onClick={handleCopy}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <div className="share-tip">
          首次打开会弹窗填名字；也可以给每台电脑准备带 <code>?name=红队-01</code> 的链接。
        </div>
        {copyError ? (
          <div className="form-error">浏览器没有允许自动复制，请手动选中上面的链接复制。</div>
        ) : null}
      </div>
    </div>
  )
}
