import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const port = 8794
const base = `http://127.0.0.1:${port}`
const dataDir = 'data-mixed'
const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const imageBase64 = fs.readFileSync('scripts/sample.png').toString('base64')

fs.rmSync(dataDir, { recursive: true, force: true })
const server = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1' },
  stdio: 'ignore',
  windowsHide: true,
})

for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break
  } catch {
    // wait
  }
  await new Promise((resolve) => setTimeout(resolve, 150))
}

const created = await (
  await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'mixed-paste-test' }),
  })
).json()

const mixedHtml = `
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:v="urn:schemas-microsoft-com:vml">
<head><meta charset="utf-8"><style><!-- p.MsoNormal { margin:0; } --></style></head>
<body lang="ZH-CN" style="font-family:宋体">
<div class="WordSection1">
  <p class="MsoNormal"><b>题目描述：</b>给定一张无向图，求 1 到 n 的最短路。</p>
  <p class="MsoNormal"><img src="file:///C:/Users/test/AppData/Local/Temp/msohtmlclip1/01/clip_image001.png" width="480" height="220"></p>
  <p class="MsoNormal">输入格式：第一行两个整数 n, m。</p>
  <p class="MsoNormal"><v:shape><v:imagedata src="file:///C:/Users/test/AppData/Local/Temp/msohtmlclip1/01/clip_image002.png" /></v:shape></p>
  <p class="MsoNormal">输出格式：输出一个整数。</p>
</div>
</body></html>`

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))

await page.goto(`${base}/d/${created.id}`, { waitUntil: 'networkidle' })
await page.locator('.name-modal input').fill('mixed-A')
await page.getByRole('button', { name: '开始编辑' }).click()
await page.locator('.lanpad-editor').waitFor({ state: 'visible' })
await page.locator('.lanpad-editor').click()

// Simulate a rich clipboard with text + two image files.
const before = await page.locator('.lanpad-editor img').count()
await page.evaluate(
  async ({ html, base64 }) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const makeFile = (name) => new File([bytes], name, { type: 'image/png' })

    const transfer = new DataTransfer()
    transfer.setData('text/html', html)
    transfer.setData('text/plain', '题目描述：给定一张无向图，求 1 到 n 的最短路。')
    transfer.items.add(makeFile('clip_image001.png'))
    transfer.items.add(makeFile('clip_image002.png'))

    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    document.querySelector('.lanpad-editor')?.dispatchEvent(event)
  },
  { html: mixedHtml, base64: imageBase64 },
)

await page.waitForFunction(
  (count) => document.querySelectorAll('.lanpad-editor img').length >= count + 2,
  before,
  { timeout: 15000 },
)
const result = await page.evaluate(() => {
  const editor = document.querySelector('.lanpad-editor')
  const html = editor?.innerHTML || ''
  const text = editor?.textContent || ''
  return {
    images: Array.from(editor?.querySelectorAll('img') || []).map((img) => ({
      src: img.getAttribute('src'),
      width: img.getAttribute('width'),
    })),
    blocks: Array.from(editor?.querySelectorAll('p, img') || [])
      .map((node) => (node.tagName === 'IMG' ? 'IMG' : node.textContent?.trim()))
      .filter(Boolean),
    text,
    hasFileUrl: html.includes('file:///'),
    hasMsoClass: html.includes('MsoNormal'),
    imageIndex: html.indexOf('<img'),
    inputIndex: text.indexOf('输入格式'),
    outputIndex: text.indexOf('输出格式'),
  }
})
console.log(result)

assert.equal(result.images.length, 2)
assert.ok(result.images.every((image) => image.src?.startsWith('/assets/')), 'images not uploaded')
assert.ok(!result.hasFileUrl, 'file:/// URL leaked into document')
assert.ok(!result.hasMsoClass, 'Word class leaked into document')
assert.ok(result.text.includes('题目描述'))
assert.ok(result.text.includes('输入格式'))
assert.ok(result.text.includes('输出格式'))
assert.ok(result.blocks.indexOf('IMG') > 0)
assert.ok(result.blocks.indexOf('IMG') < result.blocks.length - 1)
assert.ok(result.blocks[0]?.startsWith('题目描述'))
assert.ok(result.blocks.at(-1)?.startsWith('输出格式'))
console.log('MIXED HTML + IMAGE PASTE OK')

if (errors.length) {
  console.error(errors)
  process.exitCode = 1
}
await browser.close()
server.kill()
await new Promise((resolve) => setTimeout(resolve, 300))
fs.rmSync(dataDir, { recursive: true, force: true })

