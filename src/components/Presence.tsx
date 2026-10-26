import type { CSSProperties } from 'react'
import type { PresenceUser } from '../types'
import { getInitial } from '../utils'

type Props = {
  users: PresenceUser[]
}

export default function Presence({ users }: Props) {
  const visible = users.slice(0, 6)
  const extra = users.length - visible.length

  return (
    <div className="presence" title={users.map((user) => `${user.name}${user.isSelf ? '（你）' : ''}`).join('、')}>
      {visible.map((user) => (
        <span
          key={user.clientId}
          className="presence-chip"
          style={{ '--user-color': user.color } as CSSProperties}
          title={`${user.name}${user.isSelf ? '（你）' : ''}`}
        >
          <span className="presence-avatar">{getInitial(user.name)}</span>
          <span className="presence-name">
            {user.name}
            {user.isSelf ? '（你）' : ''}
          </span>
        </span>
      ))}
      {extra > 0 ? <span className="presence-extra">+{extra}</span> : null}
    </div>
  )
}
