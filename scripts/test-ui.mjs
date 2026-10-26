import { chromium } from 'playwright-core'
import fs from 'node:fs'
import assert from 'node:assert/strict'

const base = process.env.BASE_URL || 'http://127.0.0.1:8787'
const executablePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const imageBase64 = fs.readFileSync('scripts/sample.png').toString('base64')

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})

try {
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.screenshot({ path: 'scripts/screenshot-home.png', fullPage: true })
  console.log('home title:', await page.title())

  await page.getByRole('button', { name: /新建文档/ }).click()
  await page.waitForURL(/\/d\/[0-9a-z]{12}$/)
  const docUrl = page.url()
  await page.locator('.name-modal input').fill('截图测试')
  await page.getByRole('button', { name: '开始编辑' }).click()
  await page.locator('.lanpad-editor').waitFor({ state: 'visible' })

  await page.locator('.doc-title').fill('A题 · 图论与最短路')
  await page.locator('.lanpad-editor').click()
  await page.keyboard.type('题目描述：给定一张无向图，求 1 到 n 的最短路。\n\n')
  await page.getByTitle('代码块').click()
  await page.keyboard.type('int main() {\n  return 0;\n}')
  await page.locator('.tool-select').selectOption('cpp')
  await page.waitForTimeout(300)

  await page.locator('.hidden-input').setInputFiles('scripts/sample.png')
  await page.locator('.lanpad-editor img').waitFor({ state: 'visible', timeout: 8000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'scripts/screenshot-doc2.png', fullPage: true })

  const imgCountBefore = await page.locator('.lanpad-editor img').count()
  await page.evaluate(async (base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const file = new File([bytes], 'clipboard.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    document.querySelector('.lanpad-editor')?.dispatchEvent(event)
  }, imageBase64)
  await page.waitForFunction(
    (before) => document.querySelectorAll('.lanpad-editor img').length > before,
    imgCountBefore,
    { timeout: 8000 },
  )
  console.log('clipboard paste image ok')

  const title = await page.locator('.doc-title').inputValue()
  assert.equal(title, 'A题 · 图论与最短路')

  await page.getByRole('button', { name: '分享' }).click()
  const shareLink = await page.locator('.share-modal .share-link-row input').inputValue()
  console.log('share link:', shareLink)
  assert.match(shareLink, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/d\/[0-9a-z]{12}$/)
  assert.ok(!shareLink.includes('localhost'))
  await page.locator('.share-modal .btn-primary').click()
  await page.waitForTimeout(300)
  const copyLabel = await page.locator('.share-modal .btn-primary').textContent()
  const copyError = await page.locator('.share-modal .form-error').count()
  console.log('copy result:', copyLabel, 'error:', copyError)
  await page.getByRole('button', { name: '关闭' }).click()

  const readonly = await context.newPage()
  await readonly.goto(`${docUrl}?mode=view&name=评委`, { waitUntil: 'networkidle' })
  await readonly.locator('.lanpad-editor').waitFor({ state: 'visible' })
  assert.equal(await readonly.locator('.toolbar').count(), 0)
  assert.equal(await readonly.locator('.readonly-badge').count(), 1)
  assert.equal(await readonly.locator('.lanpad-editor').getAttribute('contenteditable'), 'false')
  await readonly.screenshot({ path: 'scripts/screenshot-readonly.png', fullPage: true })
  console.log('readonly ok')

  if (errors.length) {
    console.error('BROWSER ERRORS:\n' + errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('NO BROWSER ERRORS')
  }
} finally {
  await browser.close()
}
