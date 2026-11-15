<script setup lang="ts">
import { usePreferences } from './preferences'
import { computed, defineAsyncComponent, ref, shallowRef } from 'vue'
import { ElButton, ElInput } from 'element-plus'
import type { AnalysisChange, AnalysisReport, EntryPreview, ReportFormat, WorkspaceSummary } from '../shared/api'
import { isNativeLibrary } from '../shared/native-library'
const { text: t } = usePreferences()

const CodePreview = defineAsyncComponent(() => import('./CodePreview.vue'))
const emit = defineEmits<{ 'open-native': [path: string] }>()
const props = defineProps<{ id: string; projects: WorkspaceSummary[]; running: boolean }>()
const baseline = ref('')
const report = shallowRef<AnalysisReport>()
const busy = ref(false)
const error = ref('')
const notice = ref('')
const filter = ref('')
const category = ref('all')
const view = ref<'changes' | 'permissions' | 'sdks' | 'addresses' | 'libraries'>('permissions')
const side = ref<'current' | 'baseline'>('current')
const selection = shallowRef<{ change: AnalysisChange; before: EntryPreview; after: EntryPreview }>()
const active = computed(() => report.value?.[side.value])
const kindLabel = { added: '新增', removed: '删除', modified: '修改' }
const labels = { changes: '文件变化', permissions: '权限', sdks: 'SDK', addresses: '网络字符串', libraries: 'SO 文件' }
function changeCategory(item: AnalysisChange) {
  if (isNativeLibrary(item.path)) return 'native'
  if (item.path.startsWith('res/') || item.path.startsWith('assets/') || item.path === 'resources.arsc') return 'resources'
  if (item.scope === 'java' || item.path.endsWith('.smali')) return 'code'
  return 'other'
}
const changed = computed(() => (report.value?.changes ?? []).filter(item =>
  (category.value === 'all' || category.value === changeCategory(item)) && item.path.toLowerCase().includes(filter.value.toLowerCase())))
const coverage = computed(() => Object.entries(report.value?.coverage ?? {}).map(([kind, availability]) => ({
  name: kind === 'java' ? t('反编译 Java', 'Decompiled Java') : t('Smali / 资源', 'Smali / Resources'), ...availability,
})))
let selectionId = 0

async function analyze() {
  busy.value = true
  notice.value = ''
  error.value = ''
  selection.value = undefined
  selectionId++
  try {
    const response = await window.apkflux.analyze(props.id, baseline.value || undefined)
    if (response.ok) {
      report.value = response.data
      view.value = response.data.baseline ? 'changes' : 'permissions'
      side.value = 'current'
    } else error.value = response.error
  } finally { busy.value = false }
}

async function exportReport(format: ReportFormat) {
  error.value = ''
  const result = await window.apkflux.exportAnalysis(format)
  if (result.ok && result.data) notice.value = `已导出到 ${result.data}`
  else if (!result.ok) error.value = result.error
}

async function compare(change: AnalysisChange) {
  const source = report.value
  if (!source?.baseline) return
  const request = ++selectionId
  selection.value = undefined
  error.value = ''
  async function load(id: string, missing: boolean): Promise<EntryPreview> {
    if (missing) return { format: 'text', value: '' }
    const result = await (change.scope === 'archive' ? window.apkflux.preview(id, change.path)
      : window.apkflux.previewDecoded(id, change.scope, change.path))
    if (!result.ok) throw new Error(result.error)
    return result.data
  }
  try {
    const [before, after] = await Promise.all([load(source.baseline.id, change.kind === 'added'), load(source.current.id, change.kind === 'removed')])
    if (request === selectionId) selection.value = { change, before, after }
  } catch (reason) { if (request === selectionId) error.value = String(reason) }
}
</script>

<template>
  <section class="workflow-panel">
    <h2>{{ t('分析与版本对比', 'Analysis and version comparison') }}</h2>
    <div class="workflow-picker">
      <select v-model="baseline" :aria-label="t('对比基准', 'Comparison baseline')">
        <option value="">{{ t('仅分析当前 APK', 'Analyze current APK only') }}</option>
        <option v-for="project in projects.filter(item => item.id !== id)" :key="project.id" :value="project.id">{{ project.name }}</option>
      </select>
      <ElButton type="primary" :loading="busy" :disabled="running" @click="analyze">{{ t('生成报告', 'Generate report') }}</ElButton>
      <ElButton size="small" @click="emit('open-native', '')">SO / Ghidra</ElButton>
      <ElButton v-for="format in (['json', 'html', 'csv'] as const)" v-show="report" :key="format" size="small" @click="exportReport(format)">导出 {{ format.toUpperCase() }}</ElButton>
    </div>
    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
    <div v-if="notice" class="success-banner" role="status">{{ notice }}</div>
    <template v-if="report">
      <p v-for="note in report.notes" :key="note">{{ note }}</p>
      <nav class="analysis-nav" aria-label="分析分类">
        <ElButton v-for="(label, key) in labels" :key="key" size="small" :type="view === key ? 'primary' : 'default'" @click="view = key; selection = undefined">{{ label }}</ElButton>
      </nav>
      <template v-if="view === 'changes'">
        <p v-if="report.permissionChanges">权限新增 {{ report.permissionChanges.added.length }} 项，移除 {{ report.permissionChanges.removed.length }} 项。</p>
        <ul v-if="coverage.length" class="analysis-coverage">
          <li v-for="item in coverage" :key="item.name"><strong>{{ item.name }}</strong>
            <span>{{ t('基准 APK', 'Baseline APK') }} · {{ item.baseline ? t('已生成', 'Available') : t('未生成', 'Missing') }}</span>
            <span>{{ t('当前 APK', 'Current APK') }} · {{ item.current ? t('已生成', 'Available') : t('未生成', 'Missing') }}</span>
          </li>
        </ul>
        <div class="workflow-picker">
          <ElInput v-model="filter" :placeholder="t('筛选变化路径', 'Filter changes')" :aria-label="t('筛选变化路径', 'Filter changes')" />
          <select v-model="category" :aria-label="t('变化类型', 'Change category')">
            <option value="all">{{ t('全部变化', 'All changes') }}</option>
            <option value="code">{{ t('代码', 'Code') }}</option>
            <option value="resources">{{ t('资源', 'Resources') }}</option>
            <option value="native">{{ t('SO 文件', 'SO files') }}</option>
            <option value="other">{{ t('其他文件', 'Other files') }}</option>
          </select>
        </div>
        <p>{{ changed.length }} 项变化<span v-if="changed.length > 250"> · 界面显示前 250 项，导出包含全部结果</span></p>
        <div v-if="selection" class="analysis-preview">
          <div class="comparison-labels"><span>{{ t('基准 APK', 'Baseline APK') }}</span><span>{{ t('当前 APK', 'Current APK') }}</span></div>
          <CodePreview v-if="selection.before.format === 'text' && selection.after.format === 'text'" :key="selection.change.scope + selection.change.path"
            :path="selection.change.path" :original="selection.before.value" :value="selection.after.value" :draft="selection.after.value" comparing read-only />
          <div v-else-if="selection.before.format === 'image' || selection.after.format === 'image'" class="image-preview image-diff">
            <img v-if="selection.before.format === 'image'" :src="selection.before.value" :alt="t('基准 APK', 'Baseline APK')" />
            <img v-if="selection.after.format === 'image'" :src="selection.after.value" :alt="t('当前 APK', 'Current APK')" />
          </div>
          <p v-else>该条目为二进制或超过预览限制，报告已根据内容哈希比较。</p>
        </div>
        <ul class="workflow-history">
          <li v-for="row in changed.slice(0, 250)" :key="row.scope + row.path">
            <span>{{ kindLabel[row.kind] }} · {{ row.scope }} · {{ row.path }}</span>
            <ElButton size="small" @click="compare(row)">{{ t('查看变化', 'View change') }}</ElButton>
          </li>
        </ul>
      </template>
      <template v-else-if="active">
        <select v-if="report.baseline" v-model="side" aria-label="查看 APK 侧"><option value="current">{{ t('当前 APK', 'Current APK') }}</option><option value="baseline">{{ t('基准 APK', 'Baseline APK') }}</option></select>
        <p v-for="warning in active.warnings" :key="warning">{{ warning }}</p>
        <ul v-if="view === 'permissions'" class="analysis-list">
          <li v-for="item in active.permissions ?? []" :key="item.name"><strong>{{ item.name }}</strong><span>{{ item.category }} · {{ item.purpose }}</span></li>
          <li v-if="active.permissions?.length === 0">APK 未请求权限。</li>
        </ul>
        <ul v-if="view === 'sdks'" class="analysis-list">
          <li v-if="report.sdkChanges">{{ t('新增', 'Added') }} {{ report.sdkChanges.added.join(', ') || '—' }} · {{ t('移除', 'Removed') }} {{ report.sdkChanges.removed.join(', ') || '—' }}</li>
          <li v-for="item in active.sdks" :key="item.name"><strong>{{ item.name }}</strong><span>{{ item.confidence === 'high' ? '高置信度' : '中置信度' }} · {{ item.evidence }}</span></li>
        </ul>
        <ul v-if="view === 'addresses'" class="analysis-list">
          <li v-for="item in active.addresses" :key="item.value"><strong>{{ item.value }}</strong><span>{{ item.kind }} · {{ item.path }}</span></li>
        </ul>
        <ul v-if="view === 'libraries'" class="analysis-list">
          <li v-for="item in active.libraries" :key="item.path">
            <details><summary>{{ item.path }} · {{ item.architecture || item.abi }} {{ item.bits ? item.bits + ' bit' : '' }}</summary>
              <ElButton v-if="side === 'current'" size="small" @click="emit('open-native', item.path)">{{ t('用 Ghidra 查看', 'Open in Ghidra') }}</ElButton>
              <p>导出符号 · {{ item.exports.join(' · ') || '无可用符号' }}</p><p>字符串 · {{ item.strings.join(' · ') || '无可用字符串' }}</p>
            </details>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>
