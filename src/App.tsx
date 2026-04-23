import { useState, useEffect, useCallback, useRef } from 'react'

// --- Types ---

interface IconResult {
  url: string
  index: number
}

interface QuotaResponse {
  remaining: number
  total: number
}

interface ErrorResponse {
  error: string
  message: string
}

interface EnqueueResponse {
  taskId: string
  position: number
}

type GenerationPhase = 'idle' | 'queued' | 'generating' | 'complete' | 'error'

// --- Constants ---

// T-079 F3: 4 master chips replace v1.0's example-prompt chips. Display 中文,
// emit internal id over the wire. Default selection is hokusai (spec).
type MasterId = 'yoshitoshi' | 'utamaro' | 'hokusai' | 'kuniyoshi'

const MASTERS: { id: MasterId; label: string; tooltip: string }[] = [
  { id: 'yoshitoshi', label: '月冈芳年', tooltip: '戏剧 / 惊悚 / 超自然' },
  { id: 'utamaro',    label: '喜多川歌麿', tooltip: '优雅人物 / Bijin-ga' },
  { id: 'hokusai',    label: '葛饰北斋', tooltip: '山水 / Aizuri 蓝（默认）' },
  { id: 'kuniyoshi',  label: '歌川国芳', tooltip: '武者 / 动感 / 神话' },
]
const DEFAULT_MASTER: MasterId = 'hokusai'

// T-079 F6: breathe spinner — 17 frames @ 100ms, replaces the old
// inline sun-rotation SVG. Spec dictates the exact frame sequence.
// Inlined as an array (no npm dep) so worker bundle stays small.
const BREATHE_FRAMES = ['⠀','⠂','⠌','⡑','⢕','⢝','⣫','⣟','⣿','⣟','⣫','⢝','⢕','⡑','⠌','⠂','⠀']
const BREATHE_FRAME_MS = 100

const API_BASE = import.meta.env.PROD ? 'https://api-ukiyo.weweekly.online/api' : '/api'
const _params = new URLSearchParams(window.location.search)
const TEST_PARAM = _params.has('test') ? '?test' : ''

// T-079 B2: polling cadence used by the visibilitychange fallback when SSE is
// unavailable (mobile Safari background). 5s matches SPEC.md.
const TASK_POLL_MS = 5000

// --- Theme helpers ---

type Theme = 'light' | 'dark'

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem('ukiyo-e-theme')
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // localStorage not available
  }
  return 'light'
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
  try {
    localStorage.setItem('ukiyo-e-theme', theme)
  } catch {
    // localStorage not available
  }
}

// Apply initial theme immediately to avoid flash
applyTheme(getStoredTheme())

// --- Theme Toggle Component ---

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="theme-toggle fixed top-5 right-5 z-50 w-10 h-10 rounded-full flex items-center justify-center bg-white/80 dark:bg-warm-850/80 border border-warm-200 dark:border-warm-700/40 shadow-warm-sm dark:shadow-warm-md backdrop-blur-sm focus-warm"
      aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
      title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
    >
      {theme === 'dark' ? (
        // Sun icon — shown in dark mode, click to go light
        <svg className="w-5 h-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1.5M12 19.5V21M4.219 4.219l1.061 1.061M17.72 17.72l1.06 1.06M3 12h1.5M19.5 12H21M4.219 19.781l1.061-1.061M17.72 6.28l1.06-1.06" />
          <circle cx="12" cy="12" r="4.5" />
        </svg>
      ) : (
        // Moon icon — shown in light mode, click to go dark
        <svg className="w-5 h-5 text-warm-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
        </svg>
      )}
    </button>
  )
}

// --- App Component ---

export default function App() {
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [icons, setIcons] = useState<IconResult[]>([])
  const [remaining, setRemaining] = useState<number | null>(null)
  // T-079 B1: quota total was hardcoded to 3, now matches worker DAILY_LIMIT=5.
  // Server response should override this on first /api/quota fetch (we set
  // setTotal(data.total) below) but the initial fallback also reads 5/5 now
  // so first paint isn't "5/3".
  const [total, setTotal] = useState(5)
  const [error, setError] = useState<string | null>(null)
  const [rateLimited, setRateLimited] = useState(false)
  const [theme, setTheme] = useState<Theme>(getStoredTheme)
  const [phase, setPhase] = useState<GenerationPhase>('idle')
  const [queuePosition, setQueuePosition] = useState(0)
  const [retryCountdown, setRetryCountdown] = useState(0)
  const [progress, setProgress] = useState(0)
  // T-079 F3: user-selected master (default hokusai), sent on POST /api/generate.
  const [master, setMaster] = useState<MasterId>(DEFAULT_MASTER)
  // T-079 F2: lightbox state — click image to open, click again to close.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  // T-079 F6: index into BREATHE_FRAMES driven by setInterval while loading.
  const [breatheFrame, setBreatheFrame] = useState(0)
  const eventSourceRef = useRef<EventSource | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const progressRef = useRef(0)
  const sseRetriesRef = useRef(0)
  const currentTaskIdRef = useRef<string | null>(null)
  // T-079 B2: polling fallback timer when SSE is unavailable (page hidden
  // on mobile Safari). Distinct from retryTimer / progressTimer so cleanup
  // can null this independently when SSE comes back.
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch initial quota
  useEffect(() => {
    fetchQuota()
  }, [])

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
  }

  async function fetchQuota() {
    try {
      const res = await fetch(`${API_BASE}/quota${TEST_PARAM}`)
      if (res.ok) {
        const data: QuotaResponse = await res.json()
        setRemaining(data.remaining)
        // T-079 B1: also pull `total` from the server so any future change to
        // DAILY_LIMIT propagates without a frontend redeploy.
        if (typeof data.total === 'number' && data.total > 0) {
          setTotal(data.total)
        }
        if (data.remaining <= 0) {
          setRateLimited(true)
        }
      }
    } catch {
      // silently fail on quota check
    }
  }

  // Cleanup SSE and timers
  function cleanup() {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    if (retryTimerRef.current) {
      clearInterval(retryTimerRef.current)
      retryTimerRef.current = null
    }
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current)
      progressTimerRef.current = null
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }

  function startProgressAnimation(fromPct: number, toPct: number) {
    if (progressTimerRef.current) clearInterval(progressTimerRef.current)
    progressRef.current = fromPct
    setProgress(Math.round(fromPct))
    // Asymptotic curve: fast at start, slows down but never stops
    progressTimerRef.current = setInterval(() => {
      const remaining = toPct - progressRef.current
      // Move 3% of remaining distance each tick, minimum 0.1
      const step = Math.max(remaining * 0.03, 0.1)
      progressRef.current = Math.min(progressRef.current + step, toPct - 0.5)
      setProgress(Math.round(progressRef.current))
    }, 250)
  }

  // Cleanup on unmount
  useEffect(() => cleanup, [])

  // T-079 F6: drive breathe spinner frame index while loading. Single
  // setInterval; pauses (cleared) once loading flips false. The frame
  // index advances regardless of which sub-phase we're in (queued /
  // generating) so the user always sees animation, not a frozen icon.
  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => {
      setBreatheFrame((f) => (f + 1) % BREATHE_FRAMES.length)
    }, BREATHE_FRAME_MS)
    return () => clearInterval(t)
  }, [loading])

  // T-079 B2: polling fallback for iOS lock-screen SSE drop. Runs only
  // when (a) the page is hidden AND (b) we have an in-flight task. Polls
  // GET /api/task/:taskId every 5s; on `complete`/`error` it surfaces the
  // result the same way the SSE complete/error handlers do, so the user
  // unlocks their phone and sees the result immediately even if the SSE
  // pipe never woke back up.
  function startPolling(taskId: string) {
    if (pollTimerRef.current) return
    pollTimerRef.current = setInterval(async () => {
      if (!currentTaskIdRef.current) {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
        return
      }
      try {
        const res = await fetch(`${API_BASE}/task/${encodeURIComponent(taskId)}${TEST_PARAM}`)
        if (!res.ok && res.status !== 404) return
        const data = await res.json()
        if (data.state === 'complete' && Array.isArray(data.icons)) {
          // Mirror SSE complete handler.
          if (progressTimerRef.current) clearInterval(progressTimerRef.current)
          progressRef.current = 100
          setProgress(100)
          setIcons(data.icons)
          if (typeof data.remaining === 'number') {
            setRemaining(data.remaining)
            if (data.remaining <= 0) setRateLimited(true)
          }
          if (eventSourceRef.current) {
            eventSourceRef.current.onerror = null
            eventSourceRef.current.close()
            eventSourceRef.current = null
          }
          currentTaskIdRef.current = null
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
          setTimeout(() => {
            setPhase('complete')
            setLoading(false)
          }, 300)
        } else if (data.state === 'error') {
          setError(data.error || '生成失败，请重试')
          setPhase('error')
          setLoading(false)
          if (eventSourceRef.current) {
            eventSourceRef.current.onerror = null
            eventSourceRef.current.close()
            eventSourceRef.current = null
          }
          currentTaskIdRef.current = null
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
      } catch {
        // network noise; next tick will retry
      }
    }, TASK_POLL_MS)
  }

  // Reconnect SSE when page becomes visible again (mobile Safari lock/unlock)
  // T-079 B2: also start polling when the page goes hidden mid-task; stop
  // polling + try SSE resume when it comes back. Polling and SSE never run
  // together (cleanup() kills both) — the SSE complete/error path is the
  // happy case, polling is the safety net for backgrounded mobile clients.
  useEffect(() => {
    const handleVisibility = () => {
      const taskId = currentTaskIdRef.current
      if (!taskId) return
      if (document.visibilityState === 'visible') {
        // Stop polling, reconnect SSE.
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
        if (eventSourceRef.current) {
          eventSourceRef.current.onerror = null
          eventSourceRef.current.close()
          eventSourceRef.current = null
        }
        sseRetriesRef.current = 0
        startSSE(taskId)
      } else {
        // Page hidden — SSE will likely die on iOS within seconds. Start the
        // polling fallback now so we have the result waiting when the user
        // unlocks. SSE may still fire complete first; whichever wins drains
        // currentTaskIdRef + clears both timers.
        startPolling(taskId)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  function startSSE(taskId: string) {
    cleanup()
    currentTaskIdRef.current = taskId
    const url = `${API_BASE}/generate/stream?taskId=${encodeURIComponent(taskId)}`
    const es = new EventSource(url)
    eventSourceRef.current = es

    es.addEventListener('queued', (e) => {
      const data = JSON.parse(e.data)
      setPhase('queued')
      setQueuePosition(data.position)
    })

    es.addEventListener('generating', () => {
      setPhase('generating')
      // On reconnect, resume from current progress instead of resetting to 0
      const resumeFrom = Math.max(progressRef.current, 0)
      startProgressAnimation(resumeFrom, 95)
    })

    es.addEventListener('icon_ready', (e) => {
      const data = JSON.parse(e.data)
      setIcons((prev) => {
        if (prev.some((i) => i.index === data.index)) return prev
        // T-079 F1: single-image — the first (and only) icon arriving
        // snaps progress to 100%. v1.0's two-icon staircase (50% then 100%)
        // is gone with promptB.
        if (progressTimerRef.current) clearInterval(progressTimerRef.current)
        progressRef.current = 100
        setProgress(100)
        return [{ url: data.url, index: data.index }]
      })
    })

    es.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data)
      // Snap to 100% first, then fade out
      if (progressTimerRef.current) clearInterval(progressTimerRef.current)
      progressRef.current = 100
      setProgress(100)
      setRemaining(data.remaining)
      if (data.remaining <= 0) setRateLimited(true)
      // Close SSE before onerror can fire
      es.onerror = null
      es.close()
      eventSourceRef.current = null
      currentTaskIdRef.current = null
      // Delay phase transition so user sees 100%
      setTimeout(() => {
        setPhase('complete')
        setLoading(false)
      }, 800)
    })

    es.addEventListener('error', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        setError(data.message || '生成失败，请重试')
      } catch {
        setError('连接中断，请重试')
      }
      setPhase('error')
      setLoading(false)
      es.onerror = null
      es.close()
      eventSourceRef.current = null
      currentTaskIdRef.current = null
    })

    es.onerror = () => {
      // Only fire if EventSource is still our active one
      if (eventSourceRef.current !== es) return
      es.close()
      eventSourceRef.current = null
      // Auto-reconnect up to 3 times (handles mobile Safari background disconnect)
      if (sseRetriesRef.current < 3 && currentTaskIdRef.current) {
        sseRetriesRef.current++
        setTimeout(() => {
          if (currentTaskIdRef.current) {
            startSSE(currentTaskIdRef.current)
          }
        }, 1000)
      } else {
        setPhase((prev) => {
          if (prev === 'complete' || prev === 'error') return prev
          setError('连接中断，请重试')
          setLoading(false)
          return 'error'
        })
      }
    }
  }

  function startRetryCountdown(seconds: number) {
    setRetryCountdown(seconds)
    if (retryTimerRef.current) clearInterval(retryTimerRef.current)
    retryTimerRef.current = setInterval(() => {
      setRetryCountdown((prev) => {
        if (prev <= 1) {
          if (retryTimerRef.current) clearInterval(retryTimerRef.current)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  const handleGenerate = useCallback(async () => {
    const trimmed = description.trim()
    if (!trimmed || trimmed.length < 2) {
      setError('请输入至少 2 个字的描述')
      return
    }
    if (trimmed.length > 200) {
      setError('描述不能超过 200 字')
      return
    }

    setLoading(true)
    setError(null)
    setIcons([])
    setRateLimited(false)
    setPhase('queued')
    setQueuePosition(0)
    setRetryCountdown(0)
    setProgress(0)
    progressRef.current = 0
    sseRetriesRef.current = 0
    currentTaskIdRef.current = null
    cleanup()

    try {
      const res = await fetch(`${API_BASE}/generate${TEST_PARAM}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // T-079 F3: include user-selected master in the body so worker
        // skips its old "LLM picks 2 masters" step and uses this one.
        body: JSON.stringify({ description: trimmed, master }),
      })

      if (res.status === 429) {
        const data: ErrorResponse = await res.json()
        setRateLimited(true)
        setRemaining(0)
        setError(data.message)
        setPhase('error')
        setLoading(false)
        return
      }

      if (res.status === 503) {
        const data = await res.json()
        setError(data.message || '当前使用人数较多，请 30 秒后再试')
        setPhase('error')
        setLoading(false)
        startRetryCountdown(data.retryAfter || 30)
        return
      }

      if (res.status === 400) {
        const data: ErrorResponse = await res.json()
        setError(data.message)
        setPhase('error')
        setLoading(false)
        return
      }

      if (!res.ok) {
        const data: ErrorResponse = await res.json()
        setError(data.message || '生成失败，请重试')
        setPhase('error')
        setLoading(false)
        return
      }

      // 202 — task enqueued, start SSE
      const data: EnqueueResponse = await res.json()
      setQueuePosition(data.position)
      startSSE(data.taskId)
    } catch {
      setError('网络错误，请检查连接后重试')
      setPhase('error')
      setLoading(false)
    }
  }, [description, master])

  // T-079 F3: clicking a master chip just selects it (no auto-generate).
  // Switching master mid-generation doesn't cancel the in-flight request —
  // the master is captured at POST time. Visually the chip still reflects
  // the user's last click for the next generation.
  function handleMasterChange(id: MasterId) {
    setMaster(id)
    setError(null)
  }

  async function handleDownload(url: string, index: number) {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `ukiyo-e-${index + 1}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    } catch {
      // Fallback: open in new tab
      window.open(url, '_blank')
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !loading && !rateLimited) {
      e.preventDefault()
      handleGenerate()
    }
  }

  const canGenerate = description.trim().length >= 2 && !loading && !rateLimited

  return (
    <div className="min-h-screen flex flex-col items-center px-5 py-16 sm:py-24 bg-[#FAFAF7] dark:bg-warm-950">
      {/* Theme Toggle */}
      <ThemeToggle theme={theme} onToggle={toggleTheme} />

      {/* Header */}
      <header className="text-center mb-12 sm:mb-16 animate-fade-in">
        <div className="inline-flex items-center gap-3 mb-4">
          <img src="/favicon.png" alt="Ukiyo-e" className="w-10 h-10 rounded-lg" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-semibold text-warm-800 dark:text-warm-100 tracking-tight leading-tight">
          浮世绘
        </h1>
        <p className="mt-2.5 text-warm-500 dark:text-warm-400 text-base sm:text-lg font-light tracking-wide">
          描述场景，生成浮世绘风壁纸
        </p>
      </header>

      {/* Input Section */}
      <div className="w-full max-w-lg animate-slide-up">
        {/* Input row */}
        <div className="relative flex gap-2.5">
          <textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              setError(null)
            }}
            onKeyDown={handleKeyDown}
            placeholder="描述场景，例：富士山与高铁动车..."
            maxLength={200}
            disabled={loading}
            rows={1}
            className="flex-1 bg-white dark:bg-warm-900/80 border border-warm-200 dark:border-warm-700/40 rounded-2xl px-5 py-3.5 text-warm-800 dark:text-warm-100 placeholder-warm-400 dark:placeholder-warm-500 text-base font-light tracking-wide focus-warm focus:border-accent-500/30 transition-colors disabled:opacity-50 resize-none overflow-hidden shadow-warm-sm dark:shadow-none"
            style={{ minHeight: '52px' }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement
              target.style.height = '52px'
              target.style.height = target.scrollHeight + 'px'
            }}
          />
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className={`
              px-5 py-3.5 rounded-2xl font-medium text-base transition-all whitespace-nowrap
              ${loading
                ? 'bg-accent-600/40 text-accent-200 cursor-wait warm-pulse'
                : rateLimited
                  ? 'bg-warm-100 dark:bg-warm-800/60 text-warm-400 dark:text-warm-600 cursor-not-allowed'
                  : canGenerate
                    ? 'bg-accent-600 text-white hover:bg-accent-500 active:scale-[0.97] shadow-warm-md hover:shadow-warm-glow'
                    : 'bg-warm-100 dark:bg-warm-800/60 text-warm-400 dark:text-warm-600 cursor-not-allowed'
              }
            `}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <LoadingSpinner />
                <span>生成中</span>
              </span>
            ) : (
              <span>生成</span>
            )}
          </button>
        </div>

        {/* T-079 F3: master chips replace example prompts. 中文 label,
            internal id round-trips through `master` state. Selected chip is
            visually highlighted; click swaps selection (no auto-generate). */}
        <div className="mt-5 flex flex-wrap gap-2 justify-center stagger">
          {MASTERS.map((m) => {
            const selected = m.id === master
            return (
              <button
                key={m.id}
                onClick={() => handleMasterChange(m.id)}
                disabled={loading}
                title={m.tooltip}
                aria-pressed={selected}
                className={`example-pill text-sm px-3 py-1.5 rounded-full border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  selected
                    ? 'border-accent-500/60 bg-accent-50 dark:bg-accent-900/20 text-accent-700 dark:text-accent-200 font-medium'
                    : 'border-warm-200 dark:border-warm-800/50 text-warm-500'
                }`}
              >
                {m.label}
              </button>
            )
          })}
        </div>

        {/* Error message */}
        {error && (
          <div className="mt-5 text-center animate-fade-in">
            <p className="text-coral-400 text-sm font-light">{error}</p>
          </div>
        )}
      </div>

      {/* Generation progress + progressive results */}
      {loading && (
        <div className="mt-12 sm:mt-16 w-full max-w-lg animate-fade-in">
          {/* Status text — T-079 F6: breathe spinner replaces sun emoji */}
          <p className="text-center text-warm-500 dark:text-warm-600 text-sm font-light mb-5 tracking-wide">
            {phase === 'queued' && queuePosition > 1
              ? `排队中，前面 ${queuePosition - 1} 人...`
              : phase === 'queued'
                ? '准备中...'
                : phase === 'generating'
                  ? <><BreatheSpinner frame={breatheFrame} />正在锻造 <span className="text-warm-700 dark:text-warm-400 font-medium tabular-nums">{progress}%</span></>
                  : '生成中...'}
          </p>
          {/* T-079 F1: single-card layout. Mobile ~95vw via max-w + page
              padding; desktop tops out at max-w-md (~448px) so the card stays
              vertical and readable. Old 2-grid + ShimmerCard pair gone. */}
          <div className="flex justify-center">
            {icons.length > 0 ? (
              <SingleCard icon={icons[0]} onClick={() => setLightboxUrl(icons[0].url)} onDownload={handleDownload} />
            ) : (
              <SingleShimmer />
            )}
          </div>
          {/* Don't refresh hint */}
          <p className="text-center text-warm-400 dark:text-warm-700 text-xs font-light mt-4 tracking-wide">
            请不要关闭或刷新页面
          </p>
        </div>
      )}

      {/* Completed results — T-079 F1+F2: single card + lightbox trigger */}
      {!loading && icons.length > 0 && (
        <div className="mt-12 sm:mt-16 w-full max-w-lg animate-slide-up">
          <div className="flex justify-center stagger">
            <SingleCard
              icon={icons[0]}
              onClick={() => setLightboxUrl(icons[0].url)}
              onDownload={handleDownload}
            />
          </div>
        </div>
      )}

      {/* T-079 F2: lightbox — black backdrop + click-anywhere to close +
          floating download button bottom-right. Rendered at root level so
          it overlays everything regardless of scroll position. Esc also
          closes via the keydown listener. */}
      {lightboxUrl && (
        <Lightbox
          url={lightboxUrl}
          onClose={() => setLightboxUrl(null)}
          onDownload={() => handleDownload(lightboxUrl, 0)}
        />
      )}

      {/* Retry countdown */}
      {retryCountdown > 0 && !loading && (
        <div className="mt-5 text-center animate-fade-in">
          <p className="text-warm-500 dark:text-warm-600 text-sm font-light">
            <span className="text-warm-700 dark:text-warm-400 font-medium tabular-nums">{retryCountdown}</span> 秒后可重试
          </p>
        </div>
      )}

      {/* Quota display */}
      {remaining !== null && (
        <div className="mt-10 text-center animate-fade-in">
          {rateLimited ? (
            <p className="text-warm-500 dark:text-warm-600 text-sm font-light">
              内测中，每日限额已用完，请明天再来
            </p>
          ) : (
            <p className="text-warm-500 dark:text-warm-600 text-sm font-light tracking-wide">
              今日剩余{' '}
              <span className="text-warm-700 dark:text-warm-400 font-medium tabular-nums">
                {remaining}/{total}
              </span>{' '}
              次
            </p>
          )}
        </div>
      )}

      {/* Footer */}
      <footer className="mt-auto pt-20 pb-8">
        <a href="https://weweekly.online" target="_blank" rel="noopener" className="text-warm-400 dark:text-warm-700 text-xs font-light tracking-wider hover:text-warm-500 dark:hover:text-warm-500 transition-colors" style={{textDecoration:'none'}}>
          Tinker Lab / 折腾实验室
        </a>
      </footer>
    </div>
  )
}

// --- Sub-components ---

function LoadingSpinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-20"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-80"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}

// T-079 F1: SingleShimmer is the new tall-aspect placeholder (1320:2868 ≈
// 9:19.5 portrait) shown while the worker is generating. The old square
// `ShimmerCard` was sized for the 2-up icon grid that v1.1 deleted.
function SingleShimmer() {
  return (
    <div className="w-full max-w-[480px] rounded-2.5xl overflow-hidden bg-white dark:bg-warm-900/60 border border-warm-200 dark:border-warm-800/30 shadow-warm-sm dark:shadow-card">
      <div className="shimmer" style={{ aspectRatio: '1320 / 2868' }} />
    </div>
  )
}

// T-079 F1+F2: SingleCard renders the (one) generated wallpaper at the
// real 1320:2868 aspect, click-to-lightbox, with a discoverable corner
// download button (F2 said "右下悬浮下载按钮"). The old IconCard had a
// full-width "下载 PNG" pill below the image; that pill is gone per spec
// ("删除独立下载按钮"). Click on the image triggers `onClick` (lightbox);
// click on the floating button triggers `onDownload` and stops propagation
// so it doesn't double-fire the lightbox.
function SingleCard({
  icon,
  onClick,
  onDownload,
}: {
  icon: IconResult
  onClick: () => void
  onDownload: (url: string, index: number) => void
}) {
  return (
    <div className="icon-card relative w-full max-w-[480px] rounded-2.5xl overflow-hidden bg-white dark:bg-warm-900/60 border border-warm-200 dark:border-warm-800/30 shadow-warm-sm dark:shadow-card animate-slide-up">
      <button
        onClick={onClick}
        aria-label="点击查看大图"
        className="block w-full bg-[#FAFAF7] dark:bg-warm-950 p-0 cursor-zoom-in focus-warm"
        style={{ aspectRatio: '1320 / 2868' }}
      >
        <img
          src={icon.url}
          alt={`Generated wallpaper ${icon.index + 1}`}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </button>
      {/* Floating download chip — bottom-right, frosted backdrop. Discoverable
          but doesn't compete with the image for attention. */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDownload(icon.url, icon.index)
        }}
        aria-label="下载壁纸"
        title="下载壁纸"
        className="absolute bottom-3 right-3 w-11 h-11 rounded-full flex items-center justify-center bg-white/90 dark:bg-warm-900/80 backdrop-blur-md text-warm-700 dark:text-warm-200 hover:bg-white dark:hover:bg-warm-900 shadow-warm-md transition-colors focus-warm"
      >
        <DownloadIcon />
      </button>
    </div>
  )
}

// T-079 F2: full-screen lightbox. Black backdrop, single click anywhere
// closes (per spec "再点关闭"). Esc also closes. The image is sized to
// `contain` within the viewport so the full 1320×2868 wallpaper is
// visible without scrolling on phone screens. Includes a download chip
// at the bottom-right matching the card's affordance.
function Lightbox({
  url,
  onClose,
  onDownload,
}: {
  url: string
  onClose: () => void
  onDownload: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Lock body scroll while lightbox is open.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center cursor-zoom-out animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="壁纸全屏预览"
    >
      <img
        src={url}
        alt="壁纸全屏预览"
        className="max-w-full max-h-full object-contain select-none"
        draggable={false}
      />
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDownload()
        }}
        aria-label="下载壁纸"
        title="下载壁纸"
        className="absolute bottom-6 right-6 w-12 h-12 rounded-full flex items-center justify-center bg-white/90 text-warm-800 hover:bg-white shadow-warm-md transition-colors focus-warm"
      >
        <DownloadIcon />
      </button>
    </div>
  )
}

// T-079 F6 + T-080 fix: breathe spinner — inline braille glyph driven by a
// frame index passed in from App. T-080: braille codepoints have visually
// uneven vertical centroids inside their cell (⠀/⠂/⠌ sit low, ⡑ spans
// full height), so plain `align-middle` (which aligns the *baseline* of the
// glyph cell) made the spinner appear to hop above/below the adjacent sans
// text "正在锻造 X%". Fix: wrap the glyph in an inline-flex container with
// items-center + leading-none + a fixed 1em line-height box so the braille
// cell is centered inside its own line-box, then the wrapper itself docks
// to the surrounding text via items-center on the parent <p>'s vertical
// rhythm. tabular-nums + width:1ch keeps row width stable as glyph weights
// cycle.
function BreatheSpinner({ frame }: { frame: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center mr-1.5 align-middle font-mono tabular-nums leading-none text-warm-700 dark:text-warm-400"
      style={{ width: '1ch', height: '1em', lineHeight: '1em' }}
    >
      {BREATHE_FRAMES[frame % BREATHE_FRAMES.length]}
    </span>
  )
}

function DownloadIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
      />
    </svg>
  )
}
