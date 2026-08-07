export interface SseBusinessError {
  message?: string
}

/**
 * EventSource uses the same `error` event name for two different things:
 *
 * - server-sent `event: error` messages arrive as MessageEvent instances;
 * - native transport failures arrive as plain Event instances.
 *
 * Returning null for transport failures lets EventSource.onerror own reconnects.
 */
export function parseSseBusinessError(event: Event): SseBusinessError | null {
  if (!(event instanceof MessageEvent)) return null

  try {
    const data: unknown = JSON.parse(event.data)
    if (!data || typeof data !== 'object') return {}
    const message = 'message' in data && typeof data.message === 'string'
      ? data.message
      : undefined
    return { message }
  } catch {
    return {}
  }
}
