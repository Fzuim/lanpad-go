import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const port = 8801
const base = `http://127.0.0.1:${port}`
const dataDir = 'data-delete'
const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

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
  } catch {}
  await new Promise((r) => setTimeout(r, 150))
}

const created = await (
  await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'delete-test' }),
  })
).json()
const hostKey = fs.readFileSync(`${dataDir}/host-key.txt`, 'utf8').trim()

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('dialog', async (dialog) => {
  if (dialog.type() === 'confirm') await dialog.accept()
  else if (dialog.type() === 'prompt') await dialog.accept(hostKey)
  else await dialog.dismiss()
})

await page.goto(base, { waitUntil: 'networkidle' })
await page.locator('.doc-card').first().waitFor({ state: 'visible' })
assert.equal(await page.locator('.doc-card').count(), 1)

await page.locator('.doc-card .btn-danger-ghost').click()
await page.waitForFunction(() => document.querySelectorAll('.doc-card').length === 0, undefined, {
  timeout: 8000,
})
assert.equal(await page.locator('.notice-success').count(), 1)
const response = await fetch(`${base}/api/docs/${created.id}`)
assert.equal(response.status, 404)
console.log('DELETE UI OK')

if (errors.length) {
  console.error(errors)
  process.exitCode = 1
}
await browser.close()
server.kill()
await new Promise((r) => setTimeout(r, 300))
fs.rmSync(dataDir, { recursive: true, force: true })
