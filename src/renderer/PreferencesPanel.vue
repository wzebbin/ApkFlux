<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElButton } from 'element-plus'
import type { Reply, UpdateState } from '../shared/api'
import { usePreferences } from './preferences'

const prefs = usePreferences()
const t = prefs.text
const status = ref<UpdateState>()
const busy = ref(false)
const error = ref('')
const messages: Record<UpdateState['status'], [string, string]> = {
  unconfigured: ['此构建未配置更新源。', 'This build has no update feed.'],
  idle: ['等待检查。', 'Ready to check.'],
  checking: ['正在检查更新…', 'Checking for updates…'],
  available: ['有新版本。', 'An update is available.'],
  current: ['当前已是最新版本。', 'You are up to date.'],
  downloading: ['正在下载更新…', 'Downloading update…'],
  ready: ['更新已下载。', 'Update downloaded.'],
  failed: ['无法获取更新，请检查发布服务。', 'Could not retrieve the update.'],
}
async function run(action: () => Promise<Reply<UpdateState>>) {
  busy.value = true
  error.value = ''
  try {
    const result = await action()
    if (result.ok) status.value = result.data
    else error.value = result.error
  } finally { busy.value = false }
}
async function install() {
  const result = await window.apkflux.applyUpdate()
  if (!result.ok) error.value = result.error
}
const api = window.apkflux
onMounted(() => run(api.updateState))
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
    <p v-if="status">{{ t(...messages[status.status]) }} {{ status.version }}</p>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <ElButton :disabled="busy || status?.status === 'unconfigured'" @click="run(api.checkUpdate)">{{ t('检查更新', 'Check for updates') }}</ElButton>
    <ElButton v-if="status?.status === 'available'" :disabled="busy" @click="run(api.downloadUpdate)">{{ t('下载更新', 'Download update') }}</ElButton>
    <ElButton v-if="status?.status === 'ready'" :disabled="busy" @click="install">{{ t('安装更新并重启', 'Install and restart') }}</ElButton>
    <slot />
  </section>
</template>
