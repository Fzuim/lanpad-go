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

try {
  await pageA.goto(base, { waitUntil: 'networkidle' })
  await pageA.getByRole('button', { name: /新建文档/ }).click()
  await pageA.waitForURL(/\/d\/[0-9a-z]{12}$/)
  const docUrl = pageA.url()
  console.log('doc url:', docUrl)

  await pageA.locator('.name-modal input').fill('测试A')
  await pageA.getByRole('button', { name: '开始编辑' }).click()
  await pageA.locator('.lanpad-editor').waitFor({ state: 'visible' })
  await pageA.locator('.lanpad-editor').click()
  await pageA.keyboard.type('第一行：这是一道测试题目。')
  await pageA.waitForTimeout(500)

  await pageB.goto(docUrl, { waitUntil: 'networkidle' })
  await pageB.locator('.name-modal input').fill('测试B')
  await pageB.getByRole('button', { name: '开始编辑' }).click()
  await pageB.locator('.lanpad-editor').waitFor({ state: 'visible' })
  await pageB.waitForFunction(
    () => document.querySelector('.lanpad-editor')?.textContent?.includes('第一行'),
    undefined,
    { timeout: 8000 },
  )
  console.log('B sees A text')

  await pageB.locator('.lanpad-editor').click()
  await pageB.keyboard.press('End')
  await pageB.keyboard.type('\n第二行：来自 B 的补充。')
  await pageB.waitForTimeout(500)
  await pageA.waitForFunction(
    () => document.querySelector('.lanpad-editor')?.textContent?.includes('来自 B'),
    undefined,
    { timeout: 8000 },
  )
  console.log('A sees B text')

  const presenceCount = await pageA.locator('.presence-chip').count()
  assert.ok(presenceCount >= 2, `expected 2 presence chips, got ${presenceCount}`)

  await pageA.locator('.doc-title').fill('A题 · 图论')
  await pageB.waitForFunction(
    () => document.querySelector('.doc-title')?.value === 'A题 · 图论',
    undefined,
    { timeout: 8000 },
  )
  console.log('title synced')

  await pageA.getByTitle('代码块').click()
  await pageA.keyboard.type('console.log("hello")')
  await pageA.waitForTimeout(200)
  const codeText = await pageA.locator('.lanpad-editor pre code').first().textContent()
  assert.ok(codeText?.includes('console.log'), `code block missing: ${codeText}`)
  console.log('code block ok')

  await pageA.locator('.hidden-input').setInputFiles('scripts/sample.png')
  await pageA.locator('.lanpad-editor img').first().waitFor({ state: 'visible', timeout: 8000 })
  const imgSrc = await pageA.locator('.lanpad-editor img').first().getAttribute('src')
  assert.ok(imgSrc?.startsWith('/assets/'), `bad image src: ${imgSrc}`)
  const assetResponse = await contextA.request.get(`${base}${imgSrc}`)
  assert.equal(assetResponse.status(), 200)
  console.log('image upload ok:', imgSrc)

  await pageA.locator('.lanpad-editor img').first().click()
  await pageA.locator('.lightbox').waitFor({ state: 'visible' })
  await pageA.keyboard.press('Escape')
  await pageA.locator('.lightbox').waitFor({ state: 'hidden' })
  console.log('lightbox ok')

  await pageB.waitForFunction(
    (src) => document.querySelector('.lanpad-editor img')?.getAttribute('src') === src,
    imgSrc,
    { timeout: 8000 },
  )
  console.log('image synced to B')

  if (errors.length) {
    console.error('BROWSER ERRORS:\n' + errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('NO BROWSER ERRORS')
  }
} finally {
  await pageA.screenshot({ path: 'scripts/screenshot-doc.png', fullPage: true }).catch(() => {})
  await browser.close()
}
