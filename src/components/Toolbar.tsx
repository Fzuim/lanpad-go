import type { ReactNode } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'

type Props = {
  editor: Editor | null
  disabled?: boolean
  onPickImage: () => void
  onPickAttachment: () => void
}

type ToolButtonProps = {
  active?: boolean
  disabled?: boolean
  title: string
  onClick: () => void
  children: ReactNode
}

const CODE_LANGUAGES = [
  ['plaintext', '纯文本'],
  ['cpp', 'C++'],
  ['python', 'Python'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['rust', 'Rust'],
  ['go', 'Go'],
  ['sql', 'SQL'],
  ['bash', 'Bash'],
  ['json', 'JSON'],
] as const

function ToolButton({ active, disabled, title, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`tool-btn${active ? ' is-active' : ''}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export default function Toolbar({ editor, disabled, onPickImage, onPickAttachment }: Props) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return null
      return {
        bold: current.isActive('bold'),
        italic: current.isActive('italic'),
        strike: current.isActive('strike'),
        code: current.isActive('code'),
        paragraph: current.isActive('paragraph'),
        h1: current.isActive('heading', { level: 1 }),
        h2: current.isActive('heading', { level: 2 }),
        bulletList: current.isActive('bulletList'),
        orderedList: current.isActive('orderedList'),
        blockquote: current.isActive('blockquote'),
        codeBlock: current.isActive('codeBlock'),
        link: current.isActive('link'),
        language: (current.getAttributes('codeBlock').language as string) || 'plaintext',
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
      }
    },
  })

  if (!editor || !state) return null

  const chain = () => editor.chain().focus()

  return (
    <div className="toolbar" role="toolbar" aria-label="编辑工具栏">
      <div className="tool-group">
        <ToolButton
          title="正文"
          active={state.paragraph}
          disabled={disabled}
          onClick={() => chain().setParagraph().run()}
        >
          正文
        </ToolButton>
        <ToolButton
          title="一级标题"
          active={state.h1}
          disabled={disabled}
          onClick={() => chain().toggleHeading({ level: 1 }).run()}
        >
          H1
        </ToolButton>
        <ToolButton
          title="二级标题"
          active={state.h2}
          disabled={disabled}
          onClick={() => chain().toggleHeading({ level: 2 }).run()}
        >
          H2
        </ToolButton>
      </div>

      <div className="tool-sep" />

      <div className="tool-group">
        <ToolButton
          title="加粗"
          active={state.bold}
          disabled={disabled}
          onClick={() => chain().toggleBold().run()}
        >
          <b>B</b>
        </ToolButton>
        <ToolButton
          title="斜体"
          active={state.italic}
          disabled={disabled}
          onClick={() => chain().toggleItalic().run()}
        >
          <i>I</i>
        </ToolButton>
        <ToolButton
          title="删除线"
          active={state.strike}
          disabled={disabled}
          onClick={() => chain().toggleStrike().run()}
        >
          <s>S</s>
        </ToolButton>
        <ToolButton
          title="行内代码"
          active={state.code}
          disabled={disabled}
          onClick={() => chain().toggleCode().run()}
        >
          {'<>'}
        </ToolButton>
      </div>

      <div className="tool-sep" />

      <div className="tool-group">
        <ToolButton
          title="无序列表"
          active={state.bulletList}
          disabled={disabled}
          onClick={() => chain().toggleBulletList().run()}
        >
          • 列表
        </ToolButton>
        <ToolButton
          title="有序列表"
          active={state.orderedList}
          disabled={disabled}
          onClick={() => chain().toggleOrderedList().run()}
        >
          1. 列表
        </ToolButton>
        <ToolButton
          title="引用"
          active={state.blockquote}
          disabled={disabled}
          onClick={() => chain().toggleBlockquote().run()}
        >
          “”
        </ToolButton>
        <ToolButton
          title="代码块"
          active={state.codeBlock}
          disabled={disabled}
          onClick={() => chain().toggleCodeBlock().run()}
        >
          {'{ }'}
        </ToolButton>
        {state.codeBlock ? (
          <select
            className="tool-select"
            title="代码语言"
            value={state.language}
            disabled={disabled}
            onChange={(event) =>
              chain().updateAttributes('codeBlock', { language: event.target.value }).run()
            }
          >
            {CODE_LANGUAGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="tool-sep" />

      <div className="tool-group">
        <ToolButton
          title="插入链接"
          active={state.link}
          disabled={disabled}
          onClick={() => {
            if (editor.isActive('link')) {
              chain().unsetLink().run()
              return
            }
            const href = window.prompt('输入链接地址（http/https）')
            if (!href) return
            if (!/^https?:\/\//i.test(href)) {
              window.alert('只支持 http/https 链接')
              return
            }
            chain().setLink({ href }).run()
          }}
        >
          链接
        </ToolButton>
        <ToolButton title="插入截图" disabled={disabled} onClick={onPickImage}>
          截图
        </ToolButton>
        <ToolButton
          title="插入附件（最大 50MB，也可以直接粘贴文件）"
          disabled={disabled}
          onClick={onPickAttachment}
        >
          附件
        </ToolButton>
      </div>

      <div className="tool-spacer" />

      <div className="tool-group">
        <ToolButton
          title="撤销"
          disabled={disabled || !state.canUndo}
          onClick={() => chain().undo().run()}
        >
          ↶
        </ToolButton>
        <ToolButton
          title="重做"
          disabled={disabled || !state.canRedo}
          onClick={() => chain().redo().run()}
        >
          ↷
        </ToolButton>
      </div>
    </div>
  )
}
