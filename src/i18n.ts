/**
 * SPEC-205 — i18n (zh/en) with localStorage persistence.
 *
 * React-native implementation. Matches the i18n machinery that's already in
 * prod (see https://ukiyo.openclawd.co/assets/index-*.js) — this file is the
 * git source-of-truth recovery after 5/18 dist-only deploy.
 *
 * Public API:
 *   getLang(), setLang(l), toggleLang()
 *   useLang()         — subscribe to current lang (re-renders on change)
 *   useT()            — returns t(key, params?) bound to the current lang
 *
 * Storage key: `ukiyoeLang`; valid values: 'zh' | 'en'; default: 'zh'.
 * Also keeps <html lang> in sync (`zh-CN` / `en`).
 *
 * String lookup falls back: current → zh → key itself.
 * Params interpolate `{name}` placeholders (String() coerced).
 */

import { useSyncExternalStore } from 'react'

export type Lang = 'zh' | 'en'

type Dict = Record<string, string>
type Dicts = Record<Lang, Dict>

const STORAGE_KEY = 'ukiyoeLang'

const DICT: Dicts = {
  zh: {
    'theme.toLight': '切换到浅色模式',
    'theme.toDark': '切换到深色模式',
    'lang.toggleLabel': 'EN',
    'lang.toggleTitle': '切换语言',
    'master.yoshitoshi.label': '月冈芳年',
    'master.yoshitoshi.tooltip': '戏剧 / 惊悚 / 超自然',
    'master.utamaro.label': '喜多川歌麿',
    'master.utamaro.tooltip': '优雅人物 / Bijin-ga',
    'master.hokusai.label': '葛饰北斋',
    'master.hokusai.tooltip': '山水 / Aizuri 蓝（默认）',
    'master.kuniyoshi.label': '歌川国芳',
    'master.kuniyoshi.tooltip': '武者 / 动感 / 神话',
    'master.groupLabel': '画家风格',
    'hero.brand': '浮世绘',
    'hero.subtitle': '描述场景，生成浮世绘风壁纸',
    'input.placeholder': '描述场景，例：富士山与高铁动车...',
    'btn.generate': '生成',
    'btn.generating': '生成中',
    'btn.downloadWallpaper': '下载壁纸',
    'btn.viewLarge': '点击查看大图',
    'btn.fullscreenAria': '壁纸全屏预览',
    'status.queue': '排队中，前面 {n} 人...',
    'status.preparing': '准备中...',
    'status.forging': '正在锻造 ',
    'status.generating': '生成中...',
    'status.dontClose': '请不要关闭或刷新页面',
    'status.retryAfter': '秒后可重试',
    'err.generateFailed': '生成失败，请重试',
    'err.connectionBroken': '连接中断，请重试',
    'err.tooShort': '请输入至少 2 个字的描述',
    'err.tooLong': '描述不能超过 200 字',
    'err.tooBusy': '当前使用人数较多，请 30 秒后再试',
    'err.network': '网络错误，请检查连接后重试',
    'quota.dailyExhausted': '内测中，每日限额已用完，请明天再来',
    'quota.todayLeft': '今日剩余',
    'quota.timesUnit': '次',
    'footer.brand': 'Tinker Lab / 折腾实验室',
  },
  en: {
    'theme.toLight': 'Switch to light',
    'theme.toDark': 'Switch to dark',
    'lang.toggleLabel': '中',
    'lang.toggleTitle': 'Toggle language',
    'master.yoshitoshi.label': 'Yoshitoshi',
    'master.yoshitoshi.tooltip': 'Theatrical / Horror / Supernatural',
    'master.utamaro.label': 'Utamaro',
    'master.utamaro.tooltip': 'Elegant figures / Bijin-ga',
    'master.hokusai.label': 'Hokusai',
    'master.hokusai.tooltip': 'Landscape / Aizuri blue (default)',
    'master.kuniyoshi.label': 'Kuniyoshi',
    'master.kuniyoshi.tooltip': 'Warriors / Dynamic / Myth',
    'master.groupLabel': 'Master style',
    'hero.brand': 'Ukiyo-e',
    'hero.subtitle': 'Describe a scene, get a woodblock wallpaper',
    'input.placeholder': 'Describe the scene, e.g. Fuji and a bullet train...',
    'btn.generate': 'Generate',
    'btn.generating': 'Generating',
    'btn.downloadWallpaper': 'Download wallpaper',
    'btn.viewLarge': 'View large',
    'btn.fullscreenAria': 'Fullscreen preview',
    'status.queue': 'In queue, {n} ahead of you...',
    'status.preparing': 'Preparing...',
    'status.forging': 'Forging ',
    'status.generating': 'Generating...',
    'status.dontClose': "Don't close or refresh the page",
    'status.retryAfter': 's until retry',
    'err.generateFailed': 'Generation failed, please retry',
    'err.connectionBroken': 'Connection lost, please retry',
    'err.tooShort': 'Please enter at least 2 characters',
    'err.tooLong': 'Description must be under 200 characters',
    'err.tooBusy': 'High traffic right now, try again in 30s',
    'err.network': 'Network error, please check your connection',
    'quota.dailyExhausted': 'Daily beta quota used up, come back tomorrow',
    'quota.todayLeft': 'Today remaining',
    'quota.timesUnit': '',
    'footer.brand': 'Tinker Lab',
  },
}

function readInitialLang(): Lang {
  try {
    const r = localStorage.getItem(STORAGE_KEY)
    if (r === 'zh' || r === 'en') return r
  } catch {
    /* localStorage may be unavailable (private mode, file://) */
  }
  return 'zh'
}

let current: Lang = readInitialLang()

const listeners = new Set<() => void>()

function syncHtmlLang(l: Lang): void {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
  }
}

function emit(): void {
  listeners.forEach((cb) => cb())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getLang(): Lang {
  return current
}

export function setLang(l: Lang): void {
  current = l
  try {
    localStorage.setItem(STORAGE_KEY, l)
  } catch {
    /* ignore */
  }
  syncHtmlLang(l)
  emit()
}

export function toggleLang(): Lang {
  setLang(current === 'zh' ? 'en' : 'zh')
  return current
}

/** Subscribe to current lang and re-render on change. */
export function useLang(): Lang {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => 'zh' as Lang,
  )
}

/**
 * Hook that returns `t(key, params?)` bound to the current lang.
 * Falls back: current → zh → key. Interpolates `{name}` placeholders.
 */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const lang = useLang()
  return (key, params) => {
    let s = DICT[lang][key] ?? DICT.zh[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.split(`{${k}}`).join(String(v))
      }
    }
    return s
  }
}

// Keep <html lang> aligned with the persisted choice from first import.
syncHtmlLang(current)
