<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
const paths: Record<string, string> = {
  brand: 'M12 2.5 21 7.5v9l-9 5-9-5v-9l9-5Z M3.5 7.7 12 12.5l8.5-4.8 M12 12.5v8.3 M7.8 5l8.6 5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  open: 'M3 18V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1 M3 18l3.5-8H22l-3 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  files: 'M5 7H3v14h13v-2 M8 3h8l5 5v10H8V3Z M16 3v5h5',
  tool: 'M14.7 6.3a5 5 0 0 0-5.9 6.5l-5.4 5.4a1.8 1.8 0 0 0 2.5 2.5l5.4-5.4a5 5 0 0 0 6.5-5.9l-3 3-2.5-.6-.6-2.5 3-3Z',
  checklist: 'm3 6 1.5 1.5L7 5m3 1h11M3 12l1.5 1.5L7 11m3 1h11M3 18l1.5 1.5L7 17m3 1h11',
  terminal: 'M4 5h16v14H4z M7 9l3 3-3 3 M12 15h4',
  file: 'M6 3h8l4 4v14H6V3Z M14 3v5h4 M9 13h6 M9 16h6',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 11v6 M12 7h.01',
  chevron: 'm9 18 6-6-6-6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 6v6l4 2',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z M16 16l4.5 4.5',
  shield: 'm12 2 8 4v6c0 4.5-5 8-8 10-3-2-8-5.5-8-10V6l8-4Z M9 12l2 2 4-4',
  disk: 'M3 5h18v14H3z M3 13h18 M7 16h.01 M10 16h.01',
  close: 'm6 6 12 12 M18 6 6 18',
  down: 'm6 9 6 6 6-6',
  'expand-tree': 'm6 4 6 5 6-5M6 14l6 5 6-5',
  'collapse-tree': 'm6 9 6-5 6 5m-12 10 6-5 6 5',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v5h16v-5',
  refresh: 'M20 7v5h-5 M20 12a8 8 0 1 0-2.4 5.6',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-2-14-4 16',
  settings: 'M9 4h6l.7 2.6 2.6.8L21 9v6l-2.7.6-2.6.8L15 20H9l-.7-3.6-2.6-.8L3 15V9l2.7-1.6 2.6-.8L9 4Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  analysis: 'M4 4v16h16M8 15v-3m5 3V8m5 7V5',
  chip: 'M6 6h12v12H6z M9 9h6v6H9z M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3',
  build: 'M3 8h18v12H3z M8 8V5h8v3M3 13h18m-11 0v2h4v-2',
  copy: 'M9 9h11v12H9z M15 9V3H4v12h5',
}
</script>

<template>
  <svg :width="size ?? 18" :height="size ?? 18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name] ?? paths.file" />
  </svg>
</template>
