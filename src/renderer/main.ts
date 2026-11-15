import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/tree-v2/style/css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import './theme.css'

createApp(App).use(createPinia()).mount('#app')
