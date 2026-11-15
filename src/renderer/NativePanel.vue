<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { ElButton, ElInput } from 'element-plus'
import type { NativeCode, NativeFunction, NativeLibrary, Workspace } from '../shared/api'
import { isNativeLibrary, NATIVE_MAX_BYTES } from '../shared/native-library'
import { usePreferences } from './preferences'

const props = defineProps<{ workspace: Workspace; initialPath: string; running: boolean }>()
const { text: t } = usePreferences()
const libraries = computed(() => props.workspace.entries.filter((entry) => isNativeLibrary(entry.path)))
const path = ref(libraries.value.some((entry) => entry.path === props.initialPath) ? props.initialPath : libraries.value[0]?.path ?? '')
const index = shallowRef<NativeLibrary>()
const selected = shallowRef<NativeFunction>()
const code = shallowRef<NativeCode>()
const view = ref<'disassembly' | 'pseudocode'>('disassembly')
const filter = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const visible = computed(() => {
  const query = filter.value.trim().toLowerCase().replace(/^0x/, '')
  return (index.value?.functions ?? []).filter((item) => item.name.toLowerCase().includes(query) || item.address.toLowerCase().includes(query))
})
watch(path, () => { index.value = undefined; selected.value = undefined; code.value = undefined; filter.value = ''; error.value = '' })

async function chooseInstallation() {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await window.apkflux.chooseTool('ghidra')
    if (!result.ok) error.value = result.error
    else if (result.data) notice.value = t('已保存 Ghidra 安装目录。', 'Ghidra installation saved.')
  } finally { busy.value = false }
}

async function analyze() {
  busy.value = true
  error.value = ''
  notice.value = ''
  index.value = undefined
  selected.value = undefined
  code.value = undefined
  try {
    const result = await window.apkflux.analyzeNative(props.workspace.id, path.value)
    if (result.ok) index.value = result.data
    else error.value = result.error
  } finally { busy.value = false }
}

async function openFunction(item: NativeFunction) {
  busy.value = true
  error.value = ''
  selected.value = item
  code.value = undefined
  try {
    const result = await window.apkflux.nativeCode(props.workspace.id, path.value, item.address)
    if (result.ok) code.value = result.data
    else error.value = result.error
  } finally { busy.value = false }
}
</script>

<template>
  <section class="workflow-panel native-panel">
    <h2>{{ t('Ghidra 原生代码', 'Ghidra native code') }}</h2>
    <div class="workflow-picker native-toolbar">
      <select v-model="path" :aria-label="t('选择 SO 文件', 'SO file')" :disabled="busy || running">
        <option v-if="!libraries.length" value="">{{ t('此 APK 没有 SO 文件', 'This APK has no SO files') }}</option>
        <option v-for="item in libraries" :key="item.path" :value="item.path" :disabled="item.bytes > NATIVE_MAX_BYTES">{{ item.path }}</option>
      </select>
      <ElButton type="primary" :disabled="!path || busy || running" @click="analyze">{{ t('分析 SO', 'Analyze SO') }}</ElButton>
      <ElButton :disabled="busy || running" @click="chooseInstallation">{{ t('选择 Ghidra 安装目录', 'Choose Ghidra installation') }}</ElButton>
    </div>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <p v-if="notice" class="success-banner" role="status">{{ notice }}</p>
    <p v-if="busy" role="status">{{ t('正在读取 Ghidra 分析结果…', 'Reading Ghidra analysis…') }}</p>
    <template v-if="index">
      <p class="native-meta">Ghidra {{ index.engine }} · {{ index.language }} · {{ index.functions.length }} {{ t('个函数', 'functions') }}</p>
      <p v-if="index.timedOut || index.limited" class="source-warning">{{ t('已达到分析时限或索引上限，下面显示可用结果。', 'An analysis limit was reached. Available results are shown.') }}</p>
      <div class="native-split">
        <div class="native-functions">
          <ElInput v-model="filter" :placeholder="t('查找函数或地址', 'Find function or address')" :aria-label="t('查找函数或地址', 'Find function or address')" />
          <small v-if="visible.length > 150">{{ t('显示前 150 项，输入名称或地址可缩小范围。', 'Showing 150 matches. Filter to narrow the list.') }}</small>
          <small v-else-if="!visible.length">{{ t('没有匹配的函数。', 'No matching functions.') }}</small>
          <div class="native-function-list">
            <button v-for="item in visible.slice(0, 150)" :key="item.address" type="button" :disabled="busy || running"
              :aria-pressed="selected?.address === item.address" :title="item.name" @click="openFunction(item)">
              <span>{{ item.name }}</span><code>{{ item.address }}</code>
            </button>
          </div>
        </div>
        <div class="native-output">
          <nav :aria-label="t('函数视图', 'Function view')">
            <ElButton size="small" :type="view === 'disassembly' ? 'primary' : 'default'" :aria-pressed="view === 'disassembly'" @click="view = 'disassembly'">{{ t('反汇编', 'Disassembly') }}</ElButton>
            <ElButton size="small" :type="view === 'pseudocode' ? 'primary' : 'default'" :aria-pressed="view === 'pseudocode'" @click="view = 'pseudocode'">{{ t('伪代码', 'Pseudocode') }}</ElButton>
          </nav>
          <p v-if="selected" class="native-function-heading">{{ selected.name }} · 0x{{ selected.address }}</p>
          <p v-if="!selected">{{ t('从左侧选择函数。', 'Select a function.') }}</p>
          <template v-else-if="code">
            <template v-if="view === 'disassembly'">
              <p v-if="code.instructionsLimited" class="source-warning">{{ t('指令已截断。', 'Instruction output is truncated.') }}</p>
              <pre data-native-output="disassembly">{{ code.disassembly || t('没有可显示的指令。', 'No instructions available.') }}</pre>
            </template>
            <pre v-else-if="code.pseudocode" data-native-output="pseudocode">{{ code.pseudocode }}</pre>
            <p v-else>{{ t('此函数的伪代码不可用。请确认已安装当前平台的 Ghidra 原生反编译器。', 'Pseudocode is unavailable. Check the Ghidra native decompiler for this platform.') }} {{ code.pseudocodeError }}</p>
          </template>
        </div>
      </div>
    </template>
  </section>
</template>
