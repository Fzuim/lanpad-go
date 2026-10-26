/**
 * Attachment regression test: paste a .rar + .pdf, check icons/names/size,
 * Yjs propagation, reload persistence, toolbar picker and download headers.
 *
 *   BASE_URL=http://127.0.0.1:8787 node scripts/test-attachments.mjs
 */
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const base = process.env.BASE_URL || 'http://127.0.0.1:8787'
const executablePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await chromium.launch({ executablePath, headless: true })
const contextA = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const contextB = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const pageA = await contextA.newPage()
const pageB = await contextB.newPage()
const errors = []
for (const [name, page] of [
  ['A', pageA],
  ['B', pageB],
]) {
  page.on('pageerror', (error) => errors.push(`${name} pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${name} console: ${message.text()}`)
  })
}

const created = await (
  await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'attachment test' }),
  })
).json()
const docId = created.id
console.log('doc:', docId)

async function openAs(page, name) {
  await page.goto(`${base}/d/${docId}?name=${name}`, { waitUntil: 'networkidle' })
  await page.locator('.lanpad-editor').waitFor({ state: 'visible' })
  await page.waitForFunction(() =>
    document.querySelector('.conn-status')?.textContent?.includes('已同步'),
  )
}

async function pasteFiles(page, files) {
  await page.evaluate((payload) => {
    const transfer = new DataTransfer()
    for (const file of payload) {
      const bytes = new TextEncoder().encode(file.content)
      transfer.items.add(new File([bytes], file.name, { type: file.type }))
    }
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    document.querySelector('.lanpad-editor')?.dispatchEvent(event)
  }, files)
}

try {
  await openAs(pageA, 'A')
  await openAs(pageB, 'B')

  await pasteFiles(pageA, [
    {
      name: 'BaoGuaWindowsEvent.rar',
      type: 'application/vnd.rar',
      content: 'Rar!\x1a\x07\x00 fake archive payload',
    },
    { name: '题目说明.pdf', type: 'application/pdf', content: '%PDF-1.4 fake pdf' },
  ])
  await pageA.waitForFunction(
    () => document.querySelectorAll('.attachment-node').length === 2,
    undefined,
    { timeout: 10000 },
  )

  const names = await pageA.locator('.attachment-name').allInnerTexts()
  const subs = await pageA.locator('.attachment-sub').allInnerTexts()
  const labels = await pageA.locator('.file-icon-label').allInnerTexts()
  console.log('names:', names)
  console.log('sizes:', subs)
  assert.ok(names.includes('BaoGuaWindowsEvent.rar'))
  assert.ok(names.includes('题目说明.pdf'))
  assert.ok(subs.some((text) => text.includes('RAR')))
  assert.ok(subs.some((text) => text.includes('PDF')))
  assert.ok(labels.includes('RAR'))
  assert.ok(labels.includes('PDF'))
  assert.equal(await pageA.locator('.file-icon-archive').count(), 1)
  assert.equal(await pageA.locator('.file-icon-pdf').count(), 1)

  const downloads = await pageA
    .locator('.attachment-action[download]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))
  assert.ok(downloads.every((href) => href?.endsWith('?download=1')))

  await pageB.waitForFunction(
    () => document.querySelectorAll('.attachment-node').length === 2,
    undefined,
    { timeout: 10000 },
  )
  console.log('Yjs propagation ok')

  await pageA.reload({ waitUntil: 'networkidle' })
  await pageA.locator('.lanpad-editor').waitFor({ state: 'visible' })
  await pageA.waitForFunction(
    () => document.querySelectorAll('.attachment-node').length === 2,
    undefined,
    { timeout: 10000 },
  )
  console.log('reload persistence ok')

  // Toolbar "附件" path uses the second hidden file input.
  await pageA.locator('input[type=file]').nth(1).setInputFiles({
    name: '报告.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from('fake docx'),
  })
  await pageA.waitForFunction(
    () => document.querySelectorAll('.attachment-node').length === 3,
    undefined,
    { timeout: 10000 },
  )
  assert.equal(await pageA.locator('.file-icon-word').count(), 1)
  console.log('toolbar picker ok')

  const rarHref = downloads.find((href) => href?.includes('.rar'))
  const rarUrl = rarHref.replace('?download=1', '')
  const response = await contextA.request.get(`${base}${rarUrl}`)
  assert.equal(response.status(), 200)
  assert.ok((response.headers()['content-disposition'] || '').includes('attachment'))
  console.log('download disposition ok')

  await pageA.screenshot({ path: 'scripts/screenshot-attachments.png', fullPage: true })

  if (errors.length) {
    console.error('BROWSER ERRORS:\n' + errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('ATTACHMENTS OK')
  }
} finally {
  await browser.close()
}
