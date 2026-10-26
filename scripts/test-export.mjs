/**
 * Export regression test: build a document with heading/body/code/image and
 * two attachments, click 导出, then inspect the downloaded zip.
 *
 *   BASE_URL=http://127.0.0.1:8787 node scripts/test-export.mjs
 */
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import JSZip from 'jszip'

const base = process.env.BASE_URL || 'http://127.0.0.1:8787'
const executablePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})

const created = await (
  await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '导出测试' }),
  })
).json()
const docId = created.id
console.log('doc:', docId)

try {
  await page.goto(`${base}/d/${docId}?name=A`, { waitUntil: 'networkidle' })
  await page.locator('.lanpad-editor').waitFor({ state: 'visible' })
  await page.waitForFunction(() =>
    document.querySelector('.conn-status')?.textContent?.includes('已同步'),
  )

  await page.locator('.doc-title').fill('导出测试文档')
  await page.locator('.lanpad-editor').click()
  await page.keyboard.type('# 题目一')
  await page.keyboard.press('Enter')
  await page.locator('.lanpad-editor h1').waitFor({ state: 'visible', timeout: 5000 })
  await page.keyboard.type('这是正文，包含 **加粗** 的说明。')
  await page.keyboard.press('Enter')
  await page.getByTitle('代码块').click()
  await page.keyboard.type('console.log("hello")')

  await page.locator('.hidden-input').setInputFiles('scripts/sample.png')
  await page.locator('.lanpad-editor img').first().waitFor({ state: 'visible', timeout: 10000 })

  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File(
        [new TextEncoder().encode('Rar!\x1a\x07\x00 fake archive payload')],
        'BaoGuaWindowsEvent.rar',
        { type: 'application/vnd.rar' },
      ),
    )
    transfer.items.add(
      new File([new TextEncoder().encode('%PDF-1.4 fake pdf')], '题目说明.pdf', {
        type: 'application/pdf',
      }),
    )
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    document.querySelector('.lanpad-editor')?.dispatchEvent(event)
  })
  await page.waitForFunction(
    () => document.querySelectorAll('.attachment-node').length === 2,
    undefined,
    { timeout: 10000 },
  )

  fs.mkdirSync('.build', { recursive: true })
  const zipPath = '.build/export-test.zip'
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出', exact: true }).click()
  const download = await downloadPromise
  await download.saveAs(zipPath)
  assert.equal(download.suggestedFilename(), '导出测试文档.zip')
  console.log('download:', download.suggestedFilename())

  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  console.log('zip entries:', names)
  assert.ok(names.includes('document.md'))

  const markdown = await zip.file('document.md').async('string')
  assert.match(markdown, /^# 导出测试文档/)
  assert.ok(markdown.includes('# 题目一'))
  assert.ok(markdown.includes('这是正文'))
  assert.ok(markdown.includes('**加粗**'))
  assert.ok(markdown.includes('```'))
  assert.ok(markdown.includes('console.log("hello")'))

  const imageMatch = /!\[[^\]]*\]\((images\/[^)]+)\)/.exec(markdown)
  assert.ok(imageMatch, 'markdown image link missing')
  const imagePath = decodeURIComponent(imageMatch[1])
  assert.ok(names.includes(imagePath), `zip missing ${imagePath}`)
  const imageBytes = await zip.file(imagePath).async('uint8array')
  const sampleBytes = fs.readFileSync('scripts/sample.png')
  assert.equal(imageBytes.length, sampleBytes.length)
  assert.ok(Buffer.from(imageBytes).equals(sampleBytes))

  const rarMatch = /\[BaoGuaWindowsEvent\.rar\]\((files\/[^)]+)\)/.exec(markdown)
  assert.ok(rarMatch, 'rar link missing')
  const rarPath = decodeURIComponent(rarMatch[1])
  assert.ok(names.includes(rarPath), `zip missing ${rarPath}`)
  assert.ok((await zip.file(rarPath).async('string')).includes('fake archive payload'))

  const pdfMatch = /\[题目说明\.pdf\]\((files\/[^)]+)\)/.exec(markdown)
  assert.ok(pdfMatch, 'Chinese attachment link missing')
  const pdfPath = decodeURIComponent(pdfMatch[1])
  assert.ok(names.includes(pdfPath), `zip missing ${pdfPath}`)
  assert.ok((await zip.file(pdfPath).async('string')).includes('fake pdf'))
  console.log('markdown + assets ok')

  if (errors.length) {
    console.error('BROWSER ERRORS:\n' + errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('EXPORT OK')
  }
} finally {
  await browser.close()
}
