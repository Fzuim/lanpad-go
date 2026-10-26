import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { chromium } from 'playwright-core'

const port = 8791
const base = `http://127.0.0.1:${port}`
const dataDir = 'data-demo'
const executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync('docs', { recursive: true })

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
    body: JSON.stringify({ title: 'A题 · 图论与最短路' }),
  })
).json()

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
await page.goto(`${base}/d/${created.id}`, { waitUntil: 'networkidle' })
await page.locator('.name-modal input').fill('张三')
await page.getByRole('button', { name: '开始编辑' }).click()
await page.locator('.lanpad-editor').waitFor({ state: 'visible' })
await page.locator('.lanpad-editor').click()
await page.keyboard.type('题目描述：给定一张 n 个点、m 条边的无向图，求 1 到 n 的最短路。\n\n')
await page.keyboard.type('输入格式：第一行两个整数 n, m；接下来 m 行每行三个整数 u, v, w。\n\n')
await page.getByTitle('代码块').click()
await page.keyboard.type('int main() {\n  // Dijkstra\n  return 0;\n}')
await page.locator('.tool-select').selectOption('cpp')
await page.waitForTimeout(300)
await page.locator('.hidden-input').setInputFiles('scripts/sample.png')
await page.locator('.lanpad-editor img').waitFor({ state: 'visible', timeout: 8000 })
await page.waitForTimeout(600)
await page.screenshot({ path: 'docs/screenshot.png', fullPage: true })
console.log('saved docs/screenshot.png')

await browser.close()
server.kill()
await new Promise((resolve) => setTimeout(resolve, 300))
fs.rmSync(dataDir, { recursive: true, force: true })
