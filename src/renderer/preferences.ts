import { defineStore } from 'pinia'
import { ref, watchEffect } from 'vue'

export const usePreferences = defineStore('preferences', () => {
  const locale = ref<'zh' | 'en'>(localStorage.getItem('apkflux.locale') === 'en' ? 'en' : 'zh')
  const theme = ref<'dark' | 'light'>(localStorage.getItem('apkflux.theme') === 'light' ? 'light' : 'dark')

  function text(chinese: string, english: string) { return locale.value === 'en' ? english : chinese }

  watchEffect(() => {
    document.documentElement.lang = locale.value === 'en' ? 'en' : 'zh-CN'
    document.documentElement.classList.toggle('dark', theme.value === 'dark')
    document.documentElement.classList.toggle('light', theme.value === 'light')
    localStorage.setItem('apkflux.locale', locale.value)
    localStorage.setItem('apkflux.theme', theme.value)
  })
  return { locale, theme, text }
})
