<script setup lang="ts">
import { ref } from 'vue'
import { ElButton } from 'element-plus'
import { usePreferences } from './preferences'

const prefs = usePreferences()
const t = prefs.text
const error = ref('')
async function openReleases() {
  error.value = ''
  const result = await window.apkflux.openReleases()
  if (!result.ok) error.value = result.error
}
</script>

<template>
  <section class="workflow-panel">
    <h2>{{ t('应用设置', 'Preferences') }}</h2>
    <div class="workflow-fields">
      <label>{{ t('界面语言', 'Language') }}
        <select v-model="prefs.locale" aria-label="Language"><option value="zh">简体中文</option><option value="en">English</option></select>
      </label>
      <label>{{ t('主题', 'Theme') }}
        <select v-model="prefs.theme" aria-label="Theme"><option value="dark">{{ t('深色', 'Dark') }}</option><option value="light">{{ t('浅色', 'Light') }}</option></select>
      </label>
    </div>
    <h3>{{ t('应用更新', 'App updates') }}</h3>
    <p>{{ t('在 GitHub 查看并手动安装新版本。', 'View and install new versions manually from GitHub.') }}</p>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <ElButton @click="openReleases">{{ t('查看 GitHub 发布', 'View GitHub Releases') }}</ElButton>
    <slot />
  </section>
</template>
