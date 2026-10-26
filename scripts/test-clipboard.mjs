import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { chromium } from 'playwright-core'

const port = 8792
const base = `http://127.0.0.1:${port}`
const dataDir = 'data-clipboard'
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
    body: JSON.stringify({ title: 'clipboard-test' }),
  })
).json()

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))

await page.goto(`${base}/d/${created.id}`, { waitUntil: 'networkidle' })
await page.locator('.name-modal input').fill('clipboard-A')
await page.getByRole('button', { name: '开始编辑' }).click()
await page.locator('.lanpad-editor').waitFor({ state: 'visible' })

await page.evaluate(async (base64) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'image/png' })
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}, imageBase64)

await page.locator('.lanpad-editor').click()
await page.keyboard.press('Control+V')
await page.locator('.lanpad-editor img').waitFor({ state: 'visible', timeout: 10000 })
console.log('REAL CLIPBOARD PASTE OK')
if (errors.length) {
  console.error(errors)
  process.exitCode = 1
}

await browser.close()
server.kill()
await new Promise((resolve) => setTimeout(resolve, 300))
fs.rmSync(dataDir, { recursive: true, force: true })
