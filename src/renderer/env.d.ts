import type { DesktopApi } from '../shared/api'

declare global {
  interface Window { apkflux: DesktopApi }
}
