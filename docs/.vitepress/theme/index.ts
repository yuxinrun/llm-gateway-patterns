import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import HomeChapters from './components/HomeChapters.vue'
import HomeEcosystem from './components/HomeEcosystem.vue'
import BrandBanner from './components/BrandBanner.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeEcosystem', HomeEcosystem)
    app.component('HomeChapters', HomeChapters)
    app.component('BrandBanner', BrandBanner)
  }
} satisfies Theme
