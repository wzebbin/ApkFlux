import { build, context } from 'esbuild'
import { build as buildRenderer, createServer } from 'vite'
import { spawn } from 'node:child_process'

const desktop = {
  entryPoints: { 'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts' },
  bundle: true,
  external: ['electron', 'electron-updater'],
  loader: { '.java': 'text' },
  platform: 'node',
  target: 'node22',
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
}

if (process.argv.includes('--dev')) {
  const { default: electron } = await import('electron')
  const compiler = await context(desktop)
  await compiler.rebuild()
  await compiler.watch()
  const server = await createServer()
  await server.listen()
  const url = server.resolvedUrls.local[0]
  const child = spawn(electron, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, APKFLUX_DEV_URL: url },
  })
  let closing = false
  async function close(code) {
    if (closing) return
    closing = true
    if (child.exitCode === null) child.kill()
    await Promise.all([compiler.dispose(), server.close()])
    process.exitCode = code
  }
  child.on('error', (error) => { console.error(error); void close(1) })
  child.on('exit', (code) => { void close(code ?? 0) })
  process.once('SIGINT', () => { void close(130) })
  process.once('SIGTERM', () => { void close(143) })
} else {
  await Promise.all([build(desktop), buildRenderer()])
}
