import type { ApkMetadata, Signature } from '../shared/api'
import { rasterPath } from './preview'

export function parseBadging(output: string): { metadata: ApkMetadata; iconPaths: string[] } {
  const lines = output.split(/\r?\n/)
  const pkg = lines.find((line) => line.startsWith('package: '))
  const quoted = (prefix: string) => lines.find((line) => line.startsWith(prefix + "'"))?.slice(prefix.length + 1, -1) || null
  const field = (key: string) => new RegExp(`(?:^| )${key}='(.*?)'(?: |$)`).exec(pkg || '')?.[1] || null
  const packageName = field('name')
  if (!packageName) throw new Error('aapt2 未能解析 APK 的包名。')
  const application = lines.find((line) => line.startsWith("application: label='"))
  const raster = lines.flatMap((line) => {
    const entry = /^application-icon-(\d+):'(.*)'$/.exec(line)
    return entry && rasterPath(entry[2]) ? [{ density: Number(entry[1]), path: entry[2] }] : []
  }).sort((a, b) => b.density - a.density)
  const defaultIcon = / icon='(.*)'$/.exec(application || '')?.[1]
  return {
    metadata: {
      packageName,
      label: quoted('application-label:') || /^application: label='(.*?)' icon=/.exec(application || '')?.[1] || null,
      versionName: field('versionName'),
      versionCode: field('versionCode'),
      minSdk: quoted('minSdkVersion:') ?? quoted('sdkVersion:'),
      targetSdk: quoted('targetSdkVersion:'),
    },
    iconPaths: [...new Set([...raster.map((entry) => entry.path), ...(defaultIcon && rasterPath(defaultIcon) ? [defaultIcon] : [])])],
  }
}

export function parseSignature(code: number, output: string): Signature {
  if (code !== 0) {
    if (/DOES NOT VERIFY|No signatures|JAR_SIG_NO_SIGNATURES/i.test(output)) return { status: 'unverified', schemes: [], fingerprints: [] }
    return { status: 'unavailable', schemes: [], fingerprints: [] }
  }
  return {
    status: 'verified',
    schemes: [...output.matchAll(/^Verified using (v[\d.]+) scheme .*: true\s*$/gm)].map((m) => m[1]),
    fingerprints: [...new Set([...output.matchAll(/^(?:Signer #\d+|V[\d.]+ Signer:) certificate SHA-256 digest: ([a-f\d]{64})\s*$/gim)]
      .map((m) => m[1].toLowerCase()))],
  }
}
