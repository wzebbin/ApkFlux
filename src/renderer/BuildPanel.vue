<script setup lang="ts">
import { usePreferences } from './preferences'
import { onMounted, ref } from 'vue'
import { ElButton, ElInput } from 'element-plus'
import type { AndroidDevice, BuildRecord, Reply } from '../shared/api'
const { text: t } = usePreferences()

const props = defineProps<{ id: string; running: boolean }>()
const api = window.apkflux
const keystore = ref<string | null>(null)
const destination = ref<string | null>(null)
const alias = ref('')
const password = ref('')
const keyPassword = ref('')
const history = ref<BuildRecord[]>([])
const devices = ref<AndroidDevice[]>([])
const serial = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)

async function read<T>(response: Promise<Reply<T>>): Promise<T | undefined> {
  error.value = ''
  try {
    const result = await response
    if (result.ok) return result.data
    error.value = result.error
  } catch (reason) { error.value = String(reason) }
}
async function runBuild() {
  busy.value = true
  notice.value = ''
  try {
    const record = await read(window.apkflux.buildApk(props.id, { alias: alias.value.trim(), storePassword: password.value, keyPassword: keyPassword.value }))
    if (record) {
      history.value = [record, ...history.value]
      notice.value = '已构建并通过签名验证。'
    }
  } finally { busy.value = false; password.value = ''; keyPassword.value = '' }
}
async function scan() {
  devices.value = await read(window.apkflux.devices()) ?? []
  if (!devices.value.some((item) => item.serial === serial.value && item.status === 'device')) serial.value = ''
}
async function install(record: BuildRecord) {
  busy.value = true
  notice.value = ''
  try {
    const response = await window.apkflux.installBuild(props.id, record.id, serial.value)
    if (response.ok) notice.value = '已安装到所选设备。'
    else error.value = response.error
  } finally { busy.value = false }
}
async function manage(action: 'launch' | 'uninstall') {
  notice.value = ''
  await read(api.manageDevice(props.id, serial.value, action))
}
onMounted(async () => { history.value = await read(window.apkflux.buildHistory(props.id)) ?? [] })
</script>

<template>
  <section class="workflow-panel">
    <h2>{{ t('构建与签名', 'Build and sign') }}</h2>
    <p>将已保存的工作副本编译成一个新的 APK，并进行对齐和签名验证。</p>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div v-if="notice" class="success-banner" role="status">{{ notice }}</div>
    <form class="workflow-fields" @submit.prevent="runBuild">
      <div class="workflow-picker">
        <ElButton size="small" :disabled="busy || running" @click="async () => { keystore = await read(api.chooseKeystore()) ?? null }">{{ t('选择密钥库', 'Choose keystore') }}</ElButton>
        <span>{{ keystore || '尚未选择' }}</span>
      </div>
      <label>{{ t('密钥别名', 'Key alias') }}<ElInput v-model="alias" :aria-label="t('密钥别名', 'Key alias')" autocomplete="off" /></label>
      <label>{{ t('密钥库密码', 'Keystore password') }}<ElInput v-model="password" :aria-label="t('密钥库密码', 'Keystore password')" type="password" autocomplete="off" /></label>
      <label>{{ t('密钥密码（如与密钥库不同）', 'Key password (if different)') }}<ElInput v-model="keyPassword" :aria-label="t('密钥密码', 'Key password')" type="password" autocomplete="off" /></label>
      <div class="workflow-picker">
        <ElButton size="small" :disabled="busy || running" @click="async () => { destination = await read(api.chooseApkOutput()) ?? null }">{{ t('选择输出位置', 'Choose destination') }}</ElButton>
        <span>{{ destination || '尚未选择' }}</span>
      </div>
      <div><ElButton type="primary" native-type="submit" :loading="busy" :disabled="running || !keystore || !destination || !alias.trim() || !password">{{ t('构建并签名', 'Build and sign APK') }}</ElButton></div>
    </form>
    <h3>{{ t('构建记录', 'Build history') }}</h3>
    <div class="workflow-picker">
      <ElButton size="small" @click="scan">{{ t('刷新 ADB 设备', 'Refresh ADB devices') }}</ElButton>
      <select v-model="serial" :aria-label="t('ADB 设备', 'ADB device')">
        <option value="">{{ t('选择已授权设备', 'Choose authorized device') }}</option>
        <option v-for="item in devices" :key="item.serial" :value="item.serial" :disabled="item.status !== 'device'">{{ item.model || item.serial }} · {{ item.status }}</option>
      </select>
    </div>
    <ul class="workflow-history">
      <li v-for="record in history" :key="record.id"><span>{{ record.path }}</span><ElButton size="small" :disabled="running || busy || !serial" @click="install(record)">{{ t('安装到设备', 'Install on device') }}</ElButton></li>
    </ul>
    <div class="workflow-picker">
      <ElButton size="small" :disabled="running || busy || !serial" @click="manage('launch')">{{ t('启动当前应用', 'Launch app') }}</ElButton>
      <ElButton size="small" :disabled="running || busy || !serial" @click="manage('uninstall')">{{ t('卸载当前应用', 'Uninstall app') }}</ElButton>
    </div>
  </section>
</template>
