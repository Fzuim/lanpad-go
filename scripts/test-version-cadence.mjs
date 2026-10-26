/**
 * Regression test for version snapshot granularity:
 * A types 123456, B deletes the trailing 6, history must keep both states.
 *
 *   BASE_URL=http://127.0.0.1:8787 node scripts/test-version-cadence.mjs
 */
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'

const base = process.env.BASE_URL || 'http://127.0.0.1:8787'
const executablePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await chromium.launch({ executablePath, headless: true })
const contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const contextB = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const pageA = await contextA.newPage()
const pageB = await contextB.newPage()

function decode(detail) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, Uint8Array.from(Buffer.from(detail.state, 'base64')))
    const json = yDocToProsemirrorJSON(doc, 'content')
    return (json.content ?? [])
      .map((node) => (node.content ?? []).map((child) => child.text ?? '').join(''))
      .join('\n')
  } finally {
    doc.destroy()
  }
}

async function openAs(page, docId, name) {
  await page.goto(`${base}/d/${docId}?name=${name}`, { waitUntil: 'networkidle' })
  await page.locator('.lanpad-editor').waitFor({ state: 'visible' })
  await page.waitForFunction(
    () => document.querySelector('.conn-status')?.textContent?.includes('已同步'),
    undefined,
    { timeout: 10000 },
  )
}

try {
  const created = await (
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'version cadence' }),
    })
  ).json()
  const docId = created.id
  console.log('doc:', docId)

  await openAs(pageA, docId, 'A')
  await openAs(pageB, docId, 'B')

  await pageA.locator('.lanpad-editor').click()
  await pageA.keyboard.type('123456')
  await pageA.waitForTimeout(3500)

  let list = await (await fetch(`${base}/api/docs/${docId}/versions`)).json()
  let texts = []
  for (const version of list.versions) {
    const detail = await (await fetch(`${base}/api/docs/${docId}/versions/${version.id}`)).json()
    texts.push(decode(detail))
  }
  console.log('after A:', texts)
  assert.ok(texts.includes('123456'), `123456 not snapshotted: ${JSON.stringify(texts)}`)

  await pageB.locator('.lanpad-editor').click()
  await pageB.keyboard.press('End')
  await pageB.keyboard.press('Backspace')
  await pageB.waitForTimeout(3500)

  list = await (await fetch(`${base}/api/docs/${docId}/versions`)).json()
  texts = []
  for (const version of list.versions) {
    const detail = await (await fetch(`${base}/api/docs/${docId}/versions/${version.id}`)).json()
    texts.push(decode(detail))
  }
  console.log('after B:', texts)
  assert.ok(texts.includes('12345'), `12345 not snapshotted: ${JSON.stringify(texts)}`)

  await pageA.getByRole('button', { name: '历史', exact: true }).click()
  await pageA.locator('.history-modal').waitFor({ state: 'visible' })

  const cards = await pageA.locator('.history-card').count()
  let sawTransition = false
  for (let index = 0; index < cards; index++) {
    await pageA.locator('.history-card').nth(index).click()
    await pageA.waitForFunction(
      () => !document.querySelector('.history-diff .history-loading'),
      undefined,
      { timeout: 8000 },
    )
    const diff = await pageA.locator('.history-diff').innerText()
    if (diff.includes('123456') && diff.includes('12345')) sawTransition = true
  }
  assert.ok(sawTransition, 'no history card shows the 123456 -> 12345 change')

  await pageA.screenshot({ path: 'scripts/screenshot-version-cadence.png', fullPage: true })

  // Continuous typing must debounce into one snapshot, not one per 2s.
  const burstDoc = await (
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'burst count' }),
    })
  ).json()
  const burstPage = await contextA.newPage()
  await openAs(burstPage, burstDoc.id, 'Burst')
  await burstPage.locator('.lanpad-editor').click()
  await burstPage.keyboard.type('abcdefghijklmnopqrstuvwxyz0123456789', { delay: 160 })
  await burstPage.waitForTimeout(3000)
  const burstVersions = await (
    await fetch(`${base}/api/docs/${burstDoc.id}/versions`)
  ).json()
  console.log('continuous typing versions:', burstVersions.versions.length)
  assert.ok(
    burstVersions.versions.length <= 3,
    `continuous typing created too many versions: ${burstVersions.versions.length}`,
  )
  assert.ok(burstVersions.versions.length >= 2, 'continuous typing was not snapshotted')
  await burstPage.close()

  console.log('VERSION CADENCE OK')
} finally {
  await browser.close()
}
