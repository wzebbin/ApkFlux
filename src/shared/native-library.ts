export const NATIVE_MAX_BYTES = 64 * 1024 * 1024
export const isNativeLibrary = (path: string) => /^lib\/[^/]+\/[^/]+\.so$/.test(path)
