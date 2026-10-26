import { useEffect, useRef, useState, type FormEvent } from 'react'
import { randomName, sanitizeName } from '../utils'

type Props = {
  initialName: string
  onSave: (name: string) => void
}

export default function NameDialog({ initialName, onSave }: Props) {
  const [value, setValue] = useState(initialName)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const name = sanitizeName(value)
    if (!name) {
      setError('名字不能为空')
      return
    }
    onSave(name)
  }

  return (
    <div className="modal-backdrop">
      <form className="modal name-modal" onSubmit={submit}>
        <div className="modal-kicker">LAN Pad</div>
        <h2>先给自己起个名字</h2>
        <p className="modal-hint">这个名字会显示给同一文档的队友；之后可以随时修改。</p>
        <input
          ref={inputRef}
          className="text-input"
          value={value}
          maxLength={24}
          placeholder="例如：张三 / 红队-01"
          onChange={(event) => {
            setValue(event.target.value)
            setError('')
          }}
        />
        {error ? <div className="form-error">{error}</div> : null}
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setValue(randomName())
              setError('')
              inputRef.current?.focus()
            }}
          >
            随机名字
          </button>
          <button type="submit" className="btn btn-primary">
            开始编辑
          </button>
        </div>
      </form>
    </div>
  )
}
