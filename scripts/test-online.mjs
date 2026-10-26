import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const base = process.env.BASE_URL || 'http://127.0.0.1:8787'
const executablePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const browser = await chromium.launch({ executablePath, headless: true })
const c1 = await browser.newContext()
const c2 = await browser.newContext()
const p1 = await c1.newPage()
const p2 = await c2.newPage()

await p1.goto(base, { waitUntil: 'networkidle' })
await p1.getByRole('button', { name: /新建文档/ }).click()
await p1.waitForURL(/\/d\/[0-9a-z]{12}$/)
const url = p1.url()
await p1.locator('.name-modal input').fill('online-A')
await p1.getByRole('button', { name: '开始编辑' }).click()
await p1.locator('.lanpad-editor').waitFor({ state: 'visible' })
await p2.goto(url, { waitUntil: 'networkidle' })
await p2.locator('.name-modal input').fill('online-B')
await p2.getByRole('button', { name: '开始编辑' }).click()
await p2.locator('.lanpad-editor').waitFor({ state: 'visible' })
await p1.waitForTimeout(1000)
const list = await (await c1.request.get(`${base}/api/docs`)).json()
const doc = list.docs.find((item) => item.id === url.split('/').pop())
console.log('online count:', doc?.online)
assert.ok(doc?.online >= 2, `expected >=2 online, got ${doc?.online}`)

await p2.close()
await p1.waitForTimeout(1000)
const list2 = await (await c1.request.get(`${base}/api/docs`)).json()
const doc2 = list2.docs.find((item) => item.id === url.split('/').pop())
console.log('after close:', doc2?.online)
assert.equal(doc2?.online, 1)
console.log('ONLINE COUNT OK')
await browser.close()
