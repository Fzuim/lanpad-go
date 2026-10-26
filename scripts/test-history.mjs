/**
 * Browser smoke test for version history.
 *
 *   BASE_URL=http://127.0.0.1:8787 node scripts/test-history.mjs
 *
 * Creates a document, snapshots two edits, checks the diff, restores an
 * older version, verifies Ctrl+Z and that read-only viewers cannot restore.
 */
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const base = process.env.BASE_URL || 'http://127.0.0.1:8787'
const executablePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})
page.on('dialog', async (dialog) => {
  if (dialog.type() === 'confirm') await dialog.accept()
  else await dialog.dismiss()
})

try {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /新建文档/ }).click()
  await page.waitForURL(/\/d\/[0-9a-z]{12}$/)
  const docId = page.url().split('/').pop()
  console.log('doc:', docId)

  await page.locator('.name-modal input').fill('历史测试')
  await page.getByRole('button', { name: '开始编辑' }).click()
  await page.locator('.lanpad-editor').waitFor({ state: 'visible' })
  await page.waitForFunction(
    () => document.querySelector('.conn-status')?.textContent?.includes('已同步'),
    undefined,
    { timeout: 10000 },
  )

  await page.locator('.doc-title').fill('历史测试文档')
  await page.locator('.lanpad-editor').click()
  await page.keyboard.type('第一段内容')
  await page.waitForTimeout(700)
  const snap1 = await context.request.post(`${base}/api/docs/${docId}/versions`)
  assert.equal(snap1.status(), 201, `snapshot1: ${await snap1.text()}`)

  await page.locator('.lanpad-editor').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('第二段新增内容')
  await page.waitForTimeout(700)
  const snap2 = await context.request.post(`${base}/api/docs/${docId}/versions`)
  assert.equal(snap2.status(), 201, `snapshot2: ${await snap2.text()}`)

  await page.getByRole('button', { name: '历史', exact: true }).click()
  await page.locator('.history-modal').waitFor({ state: 'visible' })

  const cardCount = await page.locator('.history-card').count()
  assert.ok(cardCount >= 3, `expected >=3 cards, got ${cardCount}`)
  console.log('history cards:', cardCount, await page.locator('.history-modal h2').innerText())

  // Newest first: select the snapshot taken after the first paragraph.
  await page.locator('.history-card').nth(1).click()
  await page.waitForFunction(() => !document.querySelector('.history-diff .history-loading'), undefined, {
    timeout: 8000,
  })

  const added = await page.locator('.history-diff-row.added').allInnerTexts()
  const removed = await page.locator('.history-diff-row.removed').allInnerTexts()
  assert.ok(
    added.some((line) => line.includes('第二段新增内容')),
    'diff does not show the later edit as added',
  )
  assert.equal(removed.length, 0, `unexpected removed lines: ${removed.join(' | ')}`)
  console.log('diff ok')

  await page.screenshot({ path: 'scripts/screenshot-history.png', fullPage: true })

  await page.getByRole('button', { name: '恢复此版本' }).click()
  await page.waitForTimeout(700)
  assert.equal(await page.locator('.history-modal').count(), 0)
  const restoredText = await page.locator('.lanpad-editor').innerText()
  assert.ok(!restoredText.includes('第二段新增内容'), 'restore did not remove later edits')
  assert.ok(restoredText.includes('第一段内容'), 'restore lost earlier content')
  assert.equal(await page.locator('.doc-title').inputValue(), '历史测试文档')
  console.log('restore ok')

  // Restore is a normal shared-doc edit and can be undone with Ctrl+Z.
  await page.locator('.lanpad-editor').click()
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(700)
  const undone = await page.locator('.lanpad-editor').innerText()
  assert.ok(undone.includes('第二段新增内容'), 'Ctrl+Z did not undo the restore')
  console.log('undo ok')

  // Read-only history can be viewed but not restored.
  const readonly = await context.newPage()
  await readonly.goto(`${page.url()}?mode=view&name=评委`, { waitUntil: 'networkidle' })
  await readonly.locator('.lanpad-editor').waitFor({ state: 'visible' })
  await readonly.getByRole('button', { name: '历史', exact: true }).click()
  await readonly.locator('.history-modal').waitFor({ state: 'visible' })
  assert.equal(await readonly.getByRole('button', { name: '恢复此版本' }).isDisabled(), true)
  await readonly.screenshot({ path: 'scripts/screenshot-history-readonly.png', fullPage: true })
  console.log('readonly restore disabled')

  if (errors.length) {
    console.error('BROWSER ERRORS:\n' + errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('HISTORY UI OK')
  }
} finally {
  await browser.close()
}
