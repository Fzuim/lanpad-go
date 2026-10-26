/**
 * Smoke test for the Go backend's y-websocket/Yjs endpoint.
 *
 *   node scripts/test-go-sync.mjs <docId> [baseUrl]
 *
 * The document must already exist (create it through POST /api/docs).
 * Covers: two-client sync, awareness, reconnect, title persistence and
 * server-enforced read-only viewers.
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'

const docId = process.argv[2]
const base = (process.argv[3] || 'http://127.0.0.1:8788').replace(/\/+$/, '')
if (!docId) {
  console.error('usage: node scripts/test-go-sync.mjs <docId> [baseUrl]')
  process.exit(2)
}
const wsBase = base.replace(/^http/, 'ws') + '/collab'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function waitFor(label, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      try {
        if (predicate()) return resolve()
      } catch (error) {
        return reject(error)
      }
      if (Date.now() - started > timeout) return reject(new Error(`timeout: ${label}`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

function connect(doc, name, params = {}) {
  return new WebsocketProvider(wsBase, docId, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: { user: name, ...params },
  })
}

function synced(provider) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sync timeout')), 8000)
    provider.on('sync', (state) => {
      if (state) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

const docA = new Y.Doc()
const docB = new Y.Doc()
const providerA = connect(docA, 'Alice')
const providerB = connect(docB, 'Bob')

try {
  await Promise.all([synced(providerA), synced(providerB)])
  console.log('✓ both clients synced')

  docA.getText('probe').insert(0, 'hello-go')
  await waitFor('A -> B update', () => docB.getText('probe').toString() === 'hello-go')
  console.log('✓ document update propagated A -> B')

  providerA.awareness.setLocalStateField('user', { name: 'Alice', color: '#2563eb' })
  await waitFor('awareness', () =>
    [...providerB.awareness.getStates().values()].some((state) => state?.user?.name === 'Alice'),
  )
  console.log('✓ awareness propagated A -> B')

  docA.getText('title').insert(docA.getText('title').length, ' · Go 协作')
  await sleep(1200)
  const meta = await (await fetch(`${base}/api/docs/${docId}`)).json()
  if (!meta.title.includes('Go 协作')) throw new Error(`title not persisted: ${meta.title}`)
  console.log(`✓ title persisted: ${meta.title}`)

  const disconnected = new Promise((resolve) => {
    const onStatus = ({ status }) => {
      if (status === 'disconnected') {
        providerB.off('status', onStatus)
        resolve()
      }
    }
    providerB.on('status', onStatus)
  })
  providerB.disconnect()
  await disconnected
  docA.getText('probe').insert(0, '[reconnect] ')
  providerB.connect()
  await synced(providerB)
  await waitFor('offline update after reconnect', () =>
    docB.getText('probe').toString().startsWith('[reconnect] '),
  )
  console.log('✓ reconnect catches up')

  const docC = new Y.Doc()
  const providerC = connect(docC, 'Viewer', { mode: 'view' })
  await synced(providerC)
  docC.getText('probe').insert(0, 'MUTATION-FROM-VIEWER')
  await sleep(1000)
  if (docA.getText('probe').toString().includes('MUTATION-FROM-VIEWER')) {
    throw new Error('read-only viewer was able to write')
  }
  console.log('✓ ?mode=view is enforced by the server')
  providerC.destroy()
  docC.destroy()
} finally {
  providerA.destroy()
  providerB.destroy()
  docA.destroy()
  docB.destroy()
}

console.log('all Go sync checks passed')
