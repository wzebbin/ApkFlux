<script lang="ts">
import { languages } from 'monaco-editor/esm/vs/editor/editor.api.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'

const workers = globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker(): Worker } }
workers.MonacoEnvironment = { getWorker: () => new EditorWorker() }

languages.register({ id: 'smali' })
languages.register({ id: 'json' })
languages.setMonarchTokensProvider('json', { tokenizer: { root: [
  [/"(?:[^"\\]|\\.)*"/, 'string'], [/\b(?:true|false|null)\b/, 'keyword'],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
] } })
languages.setMonarchTokensProvider('smali', {
  tokenizer: { root: [
    [/#.*$/, 'comment'],
    [/"(?:[^"\\]|\\.)*"/, 'string'],
    [/\.[a-z][\w-]*/, 'keyword'],
    [/L[\w/$]+;/, 'type'],
    [/\b[vp]\d+\b/, 'variable'],
    [/\b(?:0x[\da-fA-F]+|\d+)\b/, 'number'],
    [/\b(?:move|return|invoke|iget|iput|sget|sput|goto|if|const|new)[\w/-]*/, 'keyword'],
  ] },
})
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { editor } from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js'
import { usePreferences } from './preferences'

const props = withDefaults(defineProps<{ path: string; value: string; tabId?: number; location?: { line: number }; original?: string; draft?: string; comparing?: boolean; readOnly?: boolean; visible?: boolean }>(), { visible: true })
const emit = defineEmits<{ change: [string]; save: [] }>()
const prefs = usePreferences()
const host = ref<HTMLElement>()
const diffHost = ref<HTMLElement>()
let view: editor.IStandaloneCodeEditor | undefined
let model: editor.ITextModel | undefined
let diff: editor.IStandaloneDiffEditor | undefined
let originalModel: editor.ITextModel | undefined
let modified: editor.ITextModel | undefined
let fileViewState: editor.ICodeEditorViewState | null | undefined
let diffViewState: editor.IDiffEditorViewState | null | undefined
let located: { line: number } | undefined

function show() {
  fileViewState = diffViewState = undefined
  const extension = props.path.split('.').at(-1)?.toLowerCase()
  const language = extension && ['xml', 'java', 'smali', 'json'].includes(extension) ? extension : 'plaintext'
  const previous = model
  model = editor.createModel(props.original === undefined ? props.value : props.draft ?? props.value, language)
  view?.setModel(model)
  located = undefined
  goToLine()
  previous?.dispose()
}

function goToLine() {
  if (!view || !props.visible || !props.location || props.location === located) return
  located = props.location
  view.setPosition({ lineNumber: located.line, column: 1 })
  view.revealLineInCenter(located.line)
}

function history(command: 'undo' | 'redo') {
  if (command === 'undo') void model?.undo()
  else void model?.redo()
  view?.focus()
}
function replace() { void view?.getAction('editor.action.startFindReplaceAction')?.run() }
defineExpose({ tabId: props.tabId, history, replace })

function disposeDiff() {
  diff?.dispose()
  originalModel?.dispose()
  modified?.dispose()
  diff = undefined
}

function showDiff(enabled: boolean | undefined) {
  if (!enabled) { disposeDiff(); return }
  if (!diffHost.value || props.original === undefined || !model) return
  diff = editor.createDiffEditor(diffHost.value, { automaticLayout: true, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false, readOnly: true, originalEditable: false, minimap: { enabled: false } })
  originalModel = editor.createModel(props.original, model.getLanguageId())
  modified = editor.createModel(props.draft ?? props.value, model.getLanguageId())
  diff.setModel({ original: originalModel, modified })
}
watch(() => props.visible, (visible) => {
  if (!visible) {
    fileViewState = view?.saveViewState()
    diffViewState = diff?.saveViewState()
    return
  }
  if (!props.comparing && view) {
    view.layout()
    if (fileViewState) view.restoreViewState(fileViewState)
  }
  if (diff) {
    diff.layout()
    if (diffViewState) diff.restoreViewState(diffViewState)
  }
  goToLine()
}, { flush: 'post' })
watch(() => props.comparing, showDiff, { flush: 'post' })
watch(() => props.draft, (value) => { if (diff && value !== undefined) modified?.setValue(value) })

onMounted(() => {
  if (!host.value) return
  editor.defineTheme('apkflux', { base: 'vs-dark', inherit: true, rules: [], colors: {
    'editor.background': '#181a1f', 'editorLineNumber.foreground': '#858d9a', 'editor.lineHighlightBackground': '#22252b',
  } })
  view = editor.create(host.value, {
    theme: prefs.theme === 'dark' ? 'apkflux' : 'vs', automaticLayout: true, readOnly: props.readOnly || props.original === undefined, domReadOnly: props.readOnly || props.original === undefined, minimap: { enabled: false },
    fontFamily: 'SFMono-Regular, Consolas, monospace', fontSize: 13, lineHeight: 22, scrollBeyondLastLine: false,
    padding: { top: 16 }, ariaLabel: 'APK 文件预览',
  })
  show()
  showDiff(props.comparing)
  view.onDidChangeModelContent(() => { if (props.original !== undefined && model) emit('change', model.getValue()) })
  view.onKeyDown((event) => {
    if (props.original !== undefined && (event.ctrlKey || event.metaKey) && event.browserEvent.key.toLowerCase() === 's') {
      event.preventDefault()
      event.stopPropagation()
      emit('save')
    }
  })
})
watch(() => [props.path, props.value], show)
watch(() => props.location, goToLine, { flush: 'post' })
watch(() => prefs.theme, (theme) => editor.setTheme(theme === 'dark' ? 'apkflux' : 'vs'))
onBeforeUnmount(() => { disposeDiff(); view?.dispose(); model?.dispose() })
</script>

<template>
  <div v-show="!comparing" ref="host" class="code-editor" />
  <div v-if="comparing" ref="diffHost" class="code-editor diff-editor" />
</template>
