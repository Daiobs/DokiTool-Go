<script setup>
import AppIcon from './AppIcon.vue'
import { computed, ref, onMounted, onUnmounted } from 'vue'
import BrandWordmark from './BrandWordmark.vue'
import { LATEST_EXTENSION_VERSION, isExtensionVersionOutdated } from '../core/capabilityHub'

const props = defineProps({
  isDark: Boolean,
  locale: String,
  t: Function,
  extensionConnected: { type: Boolean, default: false },
  extensionVersion: { type: String, default: '' },
})

const emit = defineEmits(['toggle-theme', 'set-locale', 'open-extension'])

const isExtensionOutdated = computed(
  () =>
    props.extensionConnected &&
    isExtensionVersionOutdated(props.extensionVersion, LATEST_EXTENSION_VERSION),
)

const desktopExtLabel = computed(() => {
  if (isExtensionOutdated.value) {
    return props.locale === 'en'
      ? `Ext v${props.extensionVersion} · Update v${LATEST_EXTENSION_VERSION}`
      : `扩展 v${props.extensionVersion} · 有新版 v${LATEST_EXTENSION_VERSION}`
  }
  return getLabel(props.locale, props.extensionConnected ? 'extConnectedShort' : 'extShort')
})

const mobileExtOutdatedBadge = computed(() =>
  props.locale === 'en'
    ? `Update v${LATEST_EXTENSION_VERSION}`
    : `有新版 v${LATEST_EXTENSION_VERSION}`,
)

const isMobileMenuOpen = ref(false)
const scrollProgress = ref(0)

const updateScrollProgress = () => {
  const scrollTop = window.scrollY
  const docHeight = document.documentElement.scrollHeight - window.innerHeight
  scrollProgress.value = docHeight > 0 ? Math.min(100, (scrollTop / docHeight) * 100) : 0
}

onMounted(() => {
  window.addEventListener('scroll', updateScrollProgress, { passive: true })
  updateScrollProgress()
})

onUnmounted(() => {
  window.removeEventListener('scroll', updateScrollProgress)
})

const navLinks = [
  { href: '/', labelKey: 'nav.home' },
  { href: '#Supported_Platforms', labelKey: 'nav.platforms' },
  { href: '#course', labelKey: 'nav.course' },
  { href: '#faq', labelKey: 'nav.faq' },
  { href: '#ours', labelKey: 'nav.about' }
]

const labels = {
  'zh-CN': { brand: '短视频解析', subtitle: '无水印 · 免费', home: '首页', course: '解析教程', platforms: '支持平台', faq: '常见问题', about: '关于我们', extShort: 'Chrome 扩展', extConnectedShort: '扩展已连接', extFull: 'Chrome 扩展下载', menu: '菜单', close: '关闭' },
  'en': { brand: 'Video Parser', subtitle: 'No Watermark · Free', home: 'Home', course: 'Tutorial', platforms: 'Platforms', faq: 'FAQ', about: 'About', extShort: 'Chrome Ext', extConnectedShort: 'Ext Connected', extFull: 'Chrome Extension', menu: 'Menu', close: 'Close' }
}

const getLabel = (locale, key) => labels[locale]?.[key] || labels['zh-CN'][key]

const toggleMobileMenu = () => {
  isMobileMenuOpen.value = !isMobileMenuOpen.value
}

const closeMobileMenu = () => {
  isMobileMenuOpen.value = false
}

const handleNavClick = (href) => {
  closeMobileMenu()
  if (href === '/') {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } else if (href && href.startsWith('#')) {
    setTimeout(() => {
      const element = document.querySelector(href)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, 100)
  }
}

const openExtensionFromMobile = () => {
  closeMobileMenu()
  emit('open-extension')
}

const EXT_ICON_PATH = 'M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 2c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z'

const handleKeydown = (e) => {
  if (e.key === 'Escape') {
    closeMobileMenu()
  }
}
</script>

<template>
  <header
    class="theme-colors bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl sticky top-0 z-50 border-b border-slate-200/50 dark:border-slate-700/50"
    role="banner"
  >
    <div class="theme-colors absolute top-0 left-0 right-0 h-0.5 bg-slate-200/30 dark:bg-slate-700/30 overflow-hidden">
      <div
        class="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 transition-[width] duration-150 ease-out"
        :style="{ width: scrollProgress + '%' }"
      ></div>
    </div>
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16 sm:h-18">
        <a
          href="/"
          class="flex items-center gap-3 group ux-focus"
          aria-label="DokiTool 短视频解析"
        >
          <div class="w-24 h-10 rounded-xl flex items-center justify-center overflow-hidden shrink-0">
            <BrandWordmark />
          </div>
          <div class="hidden sm:block">
            <h1 class="theme-colors font-bold text-lg text-slate-800 dark:text-white tracking-tight">
              {{ getLabel(locale, 'brand') }}
            </h1>
            <p class="theme-colors text-xs text-slate-500 dark:text-slate-400">
              {{ getLabel(locale, 'subtitle') }}
            </p>
          </div>
        </a>

        <nav class="hidden md:flex items-center gap-1" role="navigation" aria-label="Main navigation">
          <a
            v-for="link in navLinks"
            :key="link.href"
            :href="link.href"
            class="theme-colors px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800/50 ux-focus"
          >
            {{ getLabel(locale, link.labelKey.split('.')[1]) }}
          </a>
        </nav>

        <div class="flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            data-extension-modal-trigger="header"
            :data-extension-connected="extensionConnected ? 'true' : undefined"
            :data-extension-outdated="isExtensionOutdated ? 'true' : undefined"
            :title="extensionConnected && extensionVersion ? `DokiTool Extension v${extensionVersion}` : undefined"
            @click="emit('open-extension')"
            :class="[
              'theme-colors hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ux-focus',
              isExtensionOutdated
                ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-400/35 dark:hover:bg-amber-500/25'
                : extensionConnected
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-400/30 dark:hover:bg-emerald-500/25'
                  : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-400/30 dark:hover:bg-indigo-500/25',
            ]"
          >
            <span
              v-if="extensionConnected"
              data-testid="header-ext-connected-dot"
              :class="['w-2 h-2 rounded-full shrink-0', isExtensionOutdated ? 'bg-amber-500' : 'bg-emerald-500']"
              aria-hidden="true"
            ></span>
            <svg
              v-else
              class="w-3.5 h-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path :d="EXT_ICON_PATH" />
            </svg>
            <span>{{ desktopExtLabel }}</span>
          </button>

          <div class="relative">
            <select
              :value="locale"
              @change="emit('set-locale', $event.target.value)"
              class="header-locale-select theme-colors appearance-none text-sm pl-3 pr-8 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-0 cursor-pointer outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 hover:bg-slate-200 dark:hover:bg-slate-700"
              aria-label="Select language"
            >
              <option value="zh-CN">中文</option>
              <option value="en">EN</option>
            </select>
            <AppIcon class="fas fa-chevron-down absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 pointer-events-none"></AppIcon>
          </div>

          <button
            @click="emit('toggle-theme')"
            class="theme-colors p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-indigo-600 dark:hover:text-indigo-400 ux-focus"
            :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
          >
            <AppIcon :class="['fas text-sm transition-transform duration-300', isDark ? 'fa-sun' : 'fa-moon']"></AppIcon>
          </button>

          <button
            @click="toggleMobileMenu"
            class="theme-colors md:hidden p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 ux-focus"
            :aria-expanded="isMobileMenuOpen"
            aria-controls="mobile-menu"
            :aria-label="getLabel(locale, isMobileMenuOpen ? 'close' : 'menu')"
          >
            <AppIcon :class="['fas text-sm transition-transform duration-300', isMobileMenuOpen ? 'fa-times' : 'fa-bars']"></AppIcon>
          </button>
        </div>
      </div>
    </div>

    <Transition
      enter-active-class="nav-menu-enter-active"
      enter-from-class="opacity-0 -translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="nav-menu-leave-active"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-2"
    >
      <div
        v-if="isMobileMenuOpen"
        id="mobile-menu"
        class="theme-colors md:hidden border-t border-slate-200/50 dark:border-slate-700/50 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl"
        @keydown="handleKeydown"
      >
        <nav class="px-4 py-3 space-y-1" role="navigation" aria-label="Mobile navigation">
          <a
            v-for="link in navLinks"
            :key="link.href"
            :href="link.href"
            @click.prevent="handleNavClick(link.href)"
            class="theme-colors block px-4 py-3 text-sm font-medium text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 ux-focus"
          >
            {{ getLabel(locale, link.labelKey.split('.')[1]) }}
          </a>
          <button
            type="button"
            data-extension-modal-trigger="mobile"
            :data-extension-connected="extensionConnected ? 'true' : undefined"
            :data-extension-outdated="isExtensionOutdated ? 'true' : undefined"
            @click="openExtensionFromMobile"
            class="theme-colors w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-indigo-600 dark:text-indigo-400 rounded-lg hover:bg-indigo-50 dark:hover:bg-slate-800 text-left ux-focus"
          >
            <svg
              class="w-4 h-4 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path :d="EXT_ICON_PATH" />
            </svg>
            <span>{{ getLabel(locale, 'extFull') }}</span>
            <span
              v-if="isExtensionOutdated"
              data-testid="mobile-ext-outdated-badge"
              class="ml-auto inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-400/35"
            >
              {{ mobileExtOutdatedBadge }}
            </span>
          </button>
        </nav>
      </div>
    </Transition>
  </header>
</template>

<style scoped>
.nav-menu-enter-active {
  transition: var(--theme-color-transition), opacity 200ms ease-out, transform 200ms ease-out;
}

.nav-menu-leave-active {
  transition: var(--theme-color-transition), opacity 150ms ease-in, transform 150ms ease-in;
}

.header-locale-select {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  background-image: none;
}
</style>
