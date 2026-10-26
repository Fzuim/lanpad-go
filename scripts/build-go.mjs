/**
 * Build a self-contained LAN Pad binary:
 *   1. copy dist/client into internal/web/dist
 *   2. go build -tags embedclient
 *
 * Run `npm run build` first when the frontend changed.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const clientDir = join(root, 'dist', 'client')
const embedDir = join(root, 'internal', 'web', 'dist')
const targetOS = process.env.GOOS || process.platform
const output = join(root, 'release', targetOS === 'win32' ? 'LANPad.exe' : 'lanpad')

if (!existsSync(join(clientDir, 'index.html'))) {
  console.error('[go:build] 前端还没构建：请先运行 npm run build')
  process.exit(1)
}

console.log('[go:build] 内嵌前端 dist/client -> internal/web/dist')
rmSync(embedDir, { recursive: true, force: true })
cpSync(clientDir, embedDir, { recursive: true })

mkdirSync(join(root, 'release'), { recursive: true })

const go = process.env.GO || (process.platform === 'win32' ? 'go.exe' : 'go')
const args = [
  'build',
  '-tags',
  'embedclient',
  '-trimpath',
  '-ldflags',
  '-s -w',
  '-o',
  output,
  './cmd/lanpad',
]

console.log(`[go:build] ${go} ${args.join(' ')}`)
const result = spawnSync(go, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: process.env.CGO_ENABLED ?? '0' },
})

if (result.error) {
  console.error(`[go:build] 无法执行 go: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const size = statSync(output).size
console.log(`[go:build] 完成: ${output} (${(size / 1024 / 1024).toFixed(1)} MB)`)
console.log('[go:build] 这个二进制已经内嵌前端，可以直接单独运行。')
