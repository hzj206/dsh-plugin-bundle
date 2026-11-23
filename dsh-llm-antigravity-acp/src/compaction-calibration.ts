/**
 * Real-usage-aware compaction pressure calibration for Antigravity sessions.
 *
 * DSH's built-in `TokenMeter` computes a character heuristic (`chars / 4`) over
 * every surface node — including historical `reasoning` blocks that Antigravity
 * Gemini does not replay in subsequent turns — and takes
 * `Math.max(providerUsage, heuristicAnchor)`. On long 1M-window coding sessions
 * this inflates estimated occupancy by ~1.7x–1.9x, causing `compaction-basic`
 * (80% threshold) to fire when real Gemini billed occupancy is only ~44%.
 *
 * This module wraps `tokenMeter.measure()` with a strictly scoped, fail-safe
 * calibrator that activates ONLY for this provider's sessions and ONLY when
 * DSH's own baseline fell back to `'estimated'` despite a valid real usage
 * report on the latest `assistant/message`. Every safety invariant of
 * `dsh-compaction-basic` and `dsh-token-meter` is preserved:
 *
 * 1. `raw.nodes` and `raw.surfaceTokens` are NEVER mutated (preserving
 *    `selectCompactableRange`, `assertStable`, and `shadowedTokenCount`).
 * 2. When `raw.baseline.kind === 'usage'` (e.g. image-heavy sessions where
 *    real usage >= heuristic), `raw` is returned untouched.
 * 3. Any provider or model switch between the last assistant message, the
 *    session's committed header, and the proposed `requestHeader` returns `raw`
 *    untouched so a smaller target window (e.g. 128K `gpt-oss`) is never
 *    under-measured.
 * 4. After a `compaction/summary` (or a newer `assistant/message` without
 *    usage) lands after the anchor, `raw` is returned untouched so
 *    `compactPressure` converges immediately on attempt 1.
 * 5. Suspiciously low provider usage (`usage / estimatedAnchor < 0.25` above
 *    20K heuristic tokens, e.g. upstream 128K context truncation) is rejected
 *    and falls back to `raw`.
 * 6. Negative `surfaceDeltaTokens` (from `tool-result-pruner` or
 *    `image-offload`) is scaled conservatively by `clamp(ratio, 0.35, 1.0)`,
 *    while positive deltas (new unsent turns/tool outputs) keep full `1.0x`
 *    weight.
 *
 * @module dsh-llm-antigravity-acp/compaction-calibration
 */

/** Reject suspiciously tiny real/heuristic ratios above 20K heuristic tokens (e.g. 128K silent truncation). */
export const MIN_REAL_TO_HEURISTIC_RATIO = 0.25

/** Heuristic anchor size above which {@link MIN_REAL_TO_HEURISTIC_RATIO} is enforced. */
export const MIN_BASELINE_FOR_RATIO_GUARD = 20_000

/** Conservative lower bound when translating heuristic prune savings into real-token savings. */
export const PRUNE_CREDIT_MIN_RATIO = 0.35

/** Bounded scan window after the latest assistant anchor for `compaction/summary` / newer turns. */
export const MAX_POST_ANCHOR_EVENT_SCAN = 2_000

/** Cordis internal symbol that unwraps a `createTraceable` service proxy to its underlying instance. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/** Provider usage record stored on `assistant/message` events. */
export interface UsageRecord {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** One positional surface node returned by `TokenMeter.measure()`. */
export interface MeasuredNode {
  readonly seq: number
  readonly tokens: number
  readonly heuristicTokens: number
}

/** Baseline union returned by `TokenMeter.measure()`. */
export type TokenMeterBaseline =
  | { readonly kind: 'usage'; readonly tokens: number; readonly usage: UsageRecord }
  | { readonly kind: 'estimated'; readonly tokens: number }
  | { readonly kind: 'none'; readonly tokens: number }

/** Structural view of `TokenMeter.measure()` output. */
export interface TokenMeterMeasurement {
  readonly logRevision: number
  readonly baseline: TokenMeterBaseline
  readonly surfaceDeltaTokens: number
  readonly totalTokens: number
  readonly surfaceTokens: number
  readonly nodes: readonly MeasuredNode[]
}

/** Structural view of a canonical DSH request header. */
export interface RequestHeaderLike {
  readonly config?: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
  }
  readonly tools?: readonly unknown[]
}

/** Structural view of a committed DSH session event. */
export interface SessionEventLike {
  readonly type?: string
  readonly seq?: number
  readonly data?: {
    readonly usage?: UsageRecord
    readonly message?: {
      readonly source?: {
        readonly kind?: string
        readonly provider?: string
        readonly model?: string
      }
    }
  }
}

/** Minimal DSH session interface read during calibration. */
export interface SessionLike {
  readonly seq?: number
  eventAt?(seq: number): SessionEventLike | undefined
  requestHeader?(): RequestHeaderLike | undefined
}

/** Minimal DSH `TokenMeter` service surface. */
export interface TokenMeterLike {
  measure(session: SessionLike, requestHeader?: RequestHeaderLike): TokenMeterMeasurement
}

/** Runtime calibration policy. */
export interface CompactionCalibrationOptions {
  /** Provider id owned by this plugin (typically `'antigravity'`). */
  readonly provider: string
  /** Live toggle read on every `measure()` call. */
  enabled(): boolean
}

/**
 * Sum disjoint provider usage buckets using the exact same formula as
 * `@deepseek-ai/dsh-token-meter` (never double-counting `reasoningTokens`).
 * @param usage - raw provider usage payload from an `assistant/message` event.
 * @returns non-negative total tokens, or `0` when the payload is absent or malformed.
 */
export function realUsageTotal(usage: unknown): number {
  if (usage === null || typeof usage !== 'object') return 0
  const record = usage as Record<string, unknown>
  const input = record.inputTokens
  const output = record.outputTokens
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return 0
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) return 0
  const cacheRead = record.cacheReadTokens ?? 0
  const cacheWrite = record.cacheWriteTokens ?? 0
  if (typeof cacheRead !== 'number' || !Number.isFinite(cacheRead) || cacheRead < 0) return 0
  if (typeof cacheWrite !== 'number' || !Number.isFinite(cacheWrite) || cacheWrite < 0) return 0
  return input + cacheRead + cacheWrite + output
}

/**
 * Estimate additional tokens introduced if `requestHeader.tools` grew relative
 * to the session's last committed header on the same model.
 */
function estimateToolsGrowthTokens(
  sessionHeader: RequestHeaderLike | undefined,
  requestHeader: RequestHeaderLike | undefined,
): number {
  if (requestHeader === undefined || !Array.isArray(requestHeader.tools)) return 0
  if (sessionHeader === undefined || !Array.isArray(sessionHeader.tools)) return 0
  if (requestHeader.tools === sessionHeader.tools) return 0
  try {
    const nextChars = JSON.stringify(requestHeader.tools).length
    const prevChars = JSON.stringify(sessionHeader.tools).length
    if (nextChars <= prevChars) return 0
    return Math.ceil((nextChars - prevChars) / 4)
  } catch {
    return 0
  }
}

/**
 * Calibrate one `TokenMeter.measure()` snapshot from real Antigravity provider
 * usage while leaving non-Antigravity sessions, model switches, image-heavy
 * sessions, post-compaction snapshots, and truncated-context anomalies
 * completely untouched.
 * @param raw - immutable measurement returned by `TokenMeter.measure()`.
 * @param session - session passed to `measure()`.
 * @param requestHeader - optional proposed request header passed to `measure()`.
 * @param options - provider filter and live toggle.
 * @returns calibrated immutable measurement, or `raw` unchanged.
 */
export function calibrateTokenMeterMeasurement(
  raw: TokenMeterMeasurement,
  session: SessionLike,
  requestHeader: RequestHeaderLike | undefined,
  options: CompactionCalibrationOptions,
): TokenMeterMeasurement {
  try {
    if (!options.enabled()) return raw
    if (raw === null || typeof raw !== 'object') return raw
    // Preserve `'usage'` (e.g. image-heavy sessions where real usage >= heuristic)
    // and `'none'` (empty sessions) untouched.
    if (raw.baseline?.kind !== 'estimated') return raw
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return raw
    if (session === null || typeof session !== 'object' || typeof session.eventAt !== 'function') return raw

    const sessionHeader = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    const effectiveHeader = requestHeader ?? sessionHeader
    const targetProvider = effectiveHeader?.config?.provider
    const targetModel = effectiveHeader?.config?.model
    if (targetProvider !== options.provider) return raw

    // Guard against pre-flight provider or model switches before request/header is committed.
    if (requestHeader !== undefined && sessionHeader?.config !== undefined) {
      const prevProvider = sessionHeader.config.provider
      const prevModel = sessionHeader.config.model
      if (prevProvider !== undefined && prevProvider !== targetProvider) return raw
      if (prevModel !== undefined && targetModel !== undefined && prevModel !== targetModel) return raw
    }

    // Locate the latest assistant/message currently on the surface. Stop at the
    // very first match so we never skip past a newer unbilled assistant reply.
    let anchorIdx = -1
    let anchorSeq = -1
    let anchorEvent: SessionEventLike | undefined
    for (let i = raw.nodes.length - 1; i >= 0; i -= 1) {
      const node = raw.nodes[i]
      if (node === undefined) continue
      const ev = session.eventAt(node.seq)
      if (ev?.type === 'assistant/message') {
        anchorIdx = i
        anchorSeq = node.seq
        anchorEvent = ev
        break
      }
    }
    if (anchorIdx < 0 || anchorEvent === undefined) return raw

    const source = anchorEvent.data?.message?.source
    if (source?.kind !== 'model' || source.provider !== options.provider) return raw
    if (targetModel !== undefined && source.model !== undefined && source.model !== targetModel) return raw

    const usage = anchorEvent.data?.usage
    const usageTotal = realUsageTotal(usage)
    if (usageTotal <= 0) return raw

    // Post-compaction & newer-assistant convergence guard:
    // If a `compaction/summary` landed after the anchor, return `raw` verbatim
    // so `dsh-compaction-basic` sees the freshly compacted heuristic surface
    // and converges immediately on attempt 1. Likewise, if a newer empty/unbilled
    // `assistant/message` exists beyond the surface anchor, defer to `raw`.
    const endSeq = typeof session.seq === 'number' && Number.isInteger(session.seq)
      ? session.seq
      : raw.logRevision
    if (typeof endSeq !== 'number' || !Number.isInteger(endSeq) || endSeq <= anchorSeq) return raw
    if (endSeq - anchorSeq > MAX_POST_ANCHOR_EVENT_SCAN) return raw
    for (let s = anchorSeq + 1; s < endSeq; s += 1) {
      const ev = session.eventAt(s)
      if (ev?.type === 'compaction/summary' || ev?.type === 'assistant/message') return raw
    }

    let postAnchorTokens = 0
    for (let i = anchorIdx + 1; i < raw.nodes.length; i += 1) {
      const tokens = raw.nodes[i]?.tokens
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
        postAnchorTokens += tokens
      }
    }

    // When `dsh-token-meter` fell into its header-mismatch branch (e.g. effort
    // or tools changed on the same model), `raw.surfaceDeltaTokens` is 0 and
    // `raw.baseline.tokens` already includes `postAnchorTokens`.
    const headerRepriced = raw.surfaceDeltaTokens === 0 && postAnchorTokens > 0
    const estimatedAnchor = headerRepriced
      ? Math.max(0, raw.baseline.tokens - postAnchorTokens)
      : raw.baseline.tokens

    // Reject suspiciously low provider usage (e.g. upstream 128K silent
    // context truncation on a large session) so we never delay compaction on a
    // corrupted usage sample.
    if (
      estimatedAnchor > MIN_BASELINE_FOR_RATIO_GUARD
      && usageTotal / estimatedAnchor < MIN_REAL_TO_HEURISTIC_RATIO
    ) {
      return raw
    }

    const ratio = estimatedAnchor > 0
      ? Math.min(1, Math.max(PRUNE_CREDIT_MIN_RATIO, usageTotal / estimatedAnchor))
      : 1

    let delta: number
    if (raw.surfaceDeltaTokens < 0) {
      // Tool-result pruning or image offload shrunk the surface: credit the
      // savings conservatively using the observed real/heuristic ratio.
      delta = Math.round(raw.surfaceDeltaTokens * ratio)
    } else if (raw.surfaceDeltaTokens > 0) {
      // New unsent user messages or tool results after the anchor keep full
      // 1.0x heuristic weight so sudden spikes never overshoot the window.
      delta = raw.surfaceDeltaTokens
    } else {
      // Header repriced on the same model (e.g. reasoningEffort or tools
      // updated) or zero new nodes since anchor.
      delta = postAnchorTokens + estimateToolsGrowthTokens(sessionHeader, requestHeader)
    }

    const calibratedTotal = Math.max(0, Math.min(raw.totalTokens, usageTotal + delta))
    const frozenUsage = Object.freeze({ ...usage! })
    return Object.freeze({
      ...raw,
      baseline: Object.freeze({
        kind: 'usage' as const,
        tokens: usageTotal,
        usage: frozenUsage,
      }),
      surfaceDeltaTokens: delta,
      totalTokens: calibratedTotal,
    })
  } catch {
    return raw
  }
}

/**
 * Unwrap a Cordis traceable service proxy (`Symbol.for('cordis.original')`) to
 * reach the underlying `TokenMeter` instance. Writing to a Cordis proxy would
 * otherwise land on a transient shadow object and leave the real service
 * untouched.
 * @param service - service proxy or raw instance.
 * @returns the underlying service object.
 */
export function unwrapCordisService<T extends object>(service: T): T {
  let target: unknown = service
  const seen = new Set<unknown>()
  while (target !== null && typeof target === 'object' && !seen.has(target)) {
    seen.add(target)
    const inner = (target as Record<symbol, unknown>)[CORDIS_ORIGINAL]
    if (inner === null || typeof inner !== 'object') break
    target = inner
  }
  return target as T
}

/**
 * Install the real-usage calibrator on DSH's shared `TokenMeter` instance and
 * return an idempotent disposer suitable for `ctx.effect(...)`.
 * @param tokenMeter - `tokenMeter` service from Cordis context.
 * @param options - provider filter and live toggle.
 * @returns disposer restoring the previous `measure` property descriptor.
 */
export function installRealUsageCompactionCalibrator(
  tokenMeter: TokenMeterLike,
  options: CompactionCalibrationOptions,
): () => void {
  const target = unwrapCordisService(tokenMeter)
  const prevDescriptor = Object.getOwnPropertyDescriptor(target, 'measure')
  const originalMeasure = target.measure
  if (typeof originalMeasure !== 'function') return () => {}

  const calibratedMeasure = function measure(
    this: unknown,
    session: SessionLike,
    requestHeader?: RequestHeaderLike,
  ): TokenMeterMeasurement {
    const raw = originalMeasure.call(this, session, requestHeader)
    return calibrateTokenMeterMeasurement(raw, session, requestHeader, options)
  }

  Object.defineProperty(target, 'measure', {
    value: calibratedMeasure,
    writable: true,
    enumerable: prevDescriptor?.enumerable ?? false,
    configurable: true,
  })

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const currentDescriptor = Object.getOwnPropertyDescriptor(target, 'measure')
    if (currentDescriptor?.value !== calibratedMeasure) return
    if (prevDescriptor !== undefined) {
      Object.defineProperty(target, 'measure', prevDescriptor)
    } else {
      delete (target as { measure?: unknown }).measure
    }
  }
}
