import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { chromium } from 'playwright-core'

const port = 8790
const base = `http://127.0.0.1:${port}`
const dataDir = 'data-e2e'
const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

fs.rmSync(dataDir, { recursive: true, force: true })

function startServer() {
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1' },
    stdio: 'ignore',
    windowsHide: true,
  })
  return child
}

async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('server did not start')
}

let server = startServer()
await waitHealth()

const created = await (
  await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'reconnect-test' }),
  })
).json()
const docUrl = `${base}/d/${created.id}`

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))

await page.goto(docUrl, { waitUntil: 'networkidle' })
await page.locator('.name-modal input').fill('reconnect-A')
await page.getByRole('button', { name: '开始编辑' }).click()
await page.locator('.lanpad-editor').waitFor({ state: 'visible' })
await page.locator('.lanpad-editor').click()
await page.keyboard.type('before-restart')
await page.waitForTimeout(1600)

server.kill()
await page.waitForTimeout(1200)
const statusAfterKill = await page.locator('.conn-status').textContent()
console.log('after kill:', statusAfterKill)

server = startServer()
await waitHealth()
await page.waitForFunction(
  () => document.querySelector('.conn-status')?.textContent?.includes('已同步'),
  undefined,
  { timeout: 20000 },
)
console.log('reconnected')
await page.locator('.lanpad-editor').click()
await page.keyboard.press('End')
await page.keyboard.type(' | after-restart')
await page.waitForTimeout(1600)
const text = await page.locator('.lanpad-editor').innerText()
console.log('text:', text)
if (!text.includes('before-restart') || !text.includes('after-restart')) {
  throw new Error('content lost across restart')
}

if (errors.length) console.log('page errors (expected reconnect noise):', errors)

server.kill()
await browser.close()
fs.rmSync(dataDir, { recursive: true, force: true })
console.log('RECONNECT OK')
