/**
 * Plan quota and per-account subscription/model entitlement reader.
 *
 * When the account holds an OAuth credential in its isolated keychain or token
 * file, reads directly from Google Cloud Code PA (`loadCodeAssist`,
 * `retrieveUserQuotaSummary`, `fetchAvailableModels` on `daily-cloudcode-pa`
 * first) so subscription tiers (`ULTRA` / `PRO` / `FREE`), Pro's independent
 * Argon weekly bucket, and regional/student model differences (`Claude 4.6` vs
 * `Claude 5.5`, `gemini-4-argon-disabled`) are reported verbatim. Falls back to
 * `agy -p /usage --output-format json` when no OAuth token is stored locally
 * (for example against a scripted fake CLI in unit tests).
 * @module dsh-llm-antigravity-acp/quota
 */

import type { TierDowngradeAlert } from './account-health.ts'
import { SYSTEM_ACCOUNT_ID, type AccountLayout } from './accounts.ts'
import type { CatalogModel } from './catalog.ts'
import {
  inspectCloudCodeAccount,
  parseTosSuspended,
  parseVerificationRequired,
  summarizeClaudeGptLabel,
  summarizeGeminiLabel,
  TosSuspendedError,
  VerificationRequiredError,
  type CloudCodeTransport,
  type SubscriptionTier,
} from './cloudcode.ts'
import { EFFORTS, type Effort } from './config.ts'
import type { ReadCredentialOptions } from './credential.ts'
import { GPT_OSS_CONTEXT_WINDOW, UNLOCKED_CONTEXT_WINDOW, type CommandRunner } from './preflight.ts'

/** One quota window. */
export interface QuotaBucket {
  id: string
  name: string
  window: string
  remainingFraction: number
  resetTime: string
  /** The CLI or upstream says this window does not apply right now, such as a 5-hour window paused after the weekly window is spent. */
  disabled?: boolean
}

/**
 * Whether one window is the weekly (7-day) bucket. Upstream either names the
 * window `weekly` or encodes it in the bucket id (`gemini-weekly`, `3p-7d`), so
 * both fields are matched. A bucket upstream marked disabled is still the
 * weekly bucket; each caller decides what an inactive window means for it.
 * @param bucket - quota window.
 * @returns true when the bucket is the weekly window.
 */
export function isWeeklyBucket(bucket: Pick<QuotaBucket, 'id' | 'window'>): boolean {
  return /week|7d/i.test(`${bucket.window} ${bucket.id}`)
}

/** One model group sharing its windows. */
export interface QuotaGroup {
  kind?: 'gemini' | 'argon' | 'claude'
  name: string
  description: string
  buckets: QuotaBucket[]
}

/** Quota and entitlement snapshot of one account. */
export interface QuotaSnapshot {
  status: 'ok' | 'error'
  updatedAt: string
  groups: QuotaGroup[]
  error?: string
  /** Google asks the owner to verify this account (Cloud Code 403 `VALIDATION_REQUIRED`). */
  verificationRequired?: boolean
  /** Browser link that clears the verification, when upstream gave one. */
  verificationUrl?: string
  /** Google suspended Antigravity on this account for Terms of Service violations. */
  tosSuspended?: boolean
  /** Official appeal form URL when suspended. */
  tosAppealUrl?: string
  /** Active subscription downgrade alert detected for this account. */
  downgradeAlert?: TierDowngradeAlert
  /** Authoritative subscription tier from `loadCodeAssist`. */
  subscriptionTier?: SubscriptionTier
  /** Human-readable subscription plan name (e.g. `Google AI Ultra`, `Google AI Pro`). */
  subscriptionName?: string
  /** Active ACP models actually entitled on this account. */
  availableModels?: CatalogModel[]
  /** Per-model offered efforts discovered from upstream. */
  effortsByModel?: Record<string, Effort[]>
  /** Per-model context window ceiling discovered from upstream. */
  maxTokensByModel?: Record<string, number>
  /** Models explicitly marked disabled for this account (e.g. `gemini-4-argon`). */
  disabledModels?: string[]
  /** True on Ultra/Enterprise where Argon shares the Gemini pool instead of a split bucket. */
  argonSharedWithGemini?: boolean
  /**
   * Account this snapshot was read from. Set by the runtime so a caller can
   * tell which subscription a number belongs to instead of assuming the account
   * that happened to serve the previous step.
   */
  accountId?: string
  /** Display name or address of that account. */
  accountLabel?: string
  /**
   * Model the caller asked about, echoed back. A client keeps a response only
   * while it still matches the model on screen, so a slow read for the previous
   * model can never overwrite the new one.
   */
  model?: string
  /** Windows that govern `model` on this account, resolved against its entitlements. */
  focus?: ModelQuotaFocus
}

/** Quota family that governs one model. */
export type QuotaFamily = 'gemini' | 'argon' | 'claude'

/**
 * Resolution of the windows that govern one model on one account.
 *
 * `entitled: false` means this account cannot serve the model at all — Argon on
 * a Pro plan, for example — and the caller must not substitute another family's
 * windows: a Pro account's untouched Gemini pool is not Argon capacity.
 */
export interface ModelQuotaFocus {
  model: string
  family: QuotaFamily
  /** Whether this account may spend the model. */
  entitled: boolean
  /** Why the model has no windows here. */
  reason?: 'model-not-entitled' | 'no-groups'
  /** Windows that govern the model; absent unless `entitled`. */
  group?: QuotaGroup
}

const CLI_EFFORT_SUFFIX = /^(.+)-(xhigh|low|medium|high)$/

function stripCliEffortLabel(displayName: string): string {
  return displayName.replace(/\s*\((XHigh|Low|Medium|High)\)\s*$/i, '').trim()
}

function defaultMaxTokensForCliModel(id: string): number {
  const lower = id.toLowerCase()
  if (lower.startsWith('gpt-oss')) return GPT_OSS_CONTEXT_WINDOW
  if (lower.startsWith('claude-') && lower.includes('5-5')) return 1_000_000
  return UNLOCKED_CONTEXT_WINDOW
}

/**
 * Parse `agy models` tab-separated output (`<id>\t<Display Name>`) into collapsed
 * model families, per-family offered efforts, and default context window ceilings.
 * Keeps standalone fixed variants (e.g. `gpt-oss-120b-medium`) and orchestrators
 * intact while collapsing multi-effort families (`gemini-4-neon-{low,medium,high,xhigh}`).
 * @param stdout - raw stdout of `agy models`.
 * @returns normalized model inventory.
 */
export function parseCliModels(stdout: string): {
  models: CatalogModel[]
  effortsByModel: Record<string, Effort[]>
  maxTokensByModel: Record<string, number>
} {
  const entries: { id: string; name: string }[] = []
  const seenRaw = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const id = line.slice(0, tab).trim()
    const name = line.slice(tab + 1).trim()
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || seenRaw.has(id)) continue
    seenRaw.add(id)
    entries.push({ id, name: name.length > 0 ? name : id })
  }

  const stemEfforts = new Map<string, Effort[]>()
  for (const entry of entries) {
    const match = CLI_EFFORT_SUFFIX.exec(entry.id)
    if (match === null) continue
    const stem = match[1] as string
    const effort = match[2] as Effort
    const list = stemEfforts.get(stem) ?? []
    if (!list.includes(effort)) list.push(effort)
    stemEfforts.set(stem, list)
  }

  const models: CatalogModel[] = []
  const effortsByModel: Record<string, Effort[]> = {}
  const maxTokensByModel: Record<string, number> = {}
  const seenFamilies = new Set<string>()

  for (const entry of entries) {
    const match = CLI_EFFORT_SUFFIX.exec(entry.id)
    const stem = match?.[1]
    const variants = stem !== undefined ? stemEfforts.get(stem) : undefined
    const collapsed = stem !== undefined && variants !== undefined && variants.length >= 2
    const familyId = collapsed ? stem : entry.id
    if (seenFamilies.has(familyId)) continue
    seenFamilies.add(familyId)

    const displayName = collapsed ? (stripCliEffortLabel(entry.name) || familyId) : entry.name
    models.push({ id: familyId, name: displayName })
    effortsByModel[familyId] = collapsed ? EFFORTS.filter(e => variants.includes(e)) : []
    maxTokensByModel[familyId] = defaultMaxTokensForCliModel(familyId)
  }

  return { models, effortsByModel, maxTokensByModel }
}

/**
 * Infer whether Argon shares the Gemini quota pool directly from `agy -p /usage`
 * group descriptions, so pure-CLI quota mode retains accurate Argon entitlement
 * without calling Cloud Code PA directly.
 * @param groups - parsed `/usage` groups.
 * @returns `true` if Gemini's description lists Argon, `false` if Argon has its own group, else `undefined`.
 */
export function inferArgonSharedWithGemini(groups: readonly QuotaGroup[]): boolean | undefined {
  if (groups.some(g => g.kind === 'argon')) return false
  const gemini = groups.find(g => g.kind === 'gemini')
  if (gemini !== undefined && /\bargon\b/i.test(gemini.description)) return true
  return undefined
}

function normalizeUsageResetTime(raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (value.length === 0) return ''
  const ms = Date.parse(value)
  // `agy -p /usage` serializes unset protobuf Timestamps as Unix epoch zero
  // (`1970-01-01T00:00:00Z`), whereas Cloud Code direct returns `""`. Normalize
  // epoch zero to empty so untouched buckets do not render as "Resets now".
  if (Number.isFinite(ms) && ms <= 0) return ''
  return value
}

/**
 * Parse `agy -p /usage --output-format json` output.
 * @param stdout - command stdout.
 * @returns the quota groups.
 */
export function parseUsage(stdout: string): QuotaGroup[] {
  const parsed = JSON.parse(stdout) as { command?: { data?: { groups?: unknown[] } } }
  const groups = parsed.command?.data?.groups
  if (!Array.isArray(groups)) throw new Error('agy /usage returned no quota groups')
  return groups.map((raw) => {
    const group = raw as { name?: string; description?: string; buckets?: unknown[] }
    const name = String(group.name ?? '')
    const lower = name.toLowerCase()
    const kind: QuotaGroup['kind'] = lower.includes('argon')
      ? 'argon'
      : (lower.includes('claude') || lower.includes('gpt') || lower.includes('3p') ? 'claude' : 'gemini')
    const rawBuckets: QuotaBucket[] = (Array.isArray(group.buckets) ? group.buckets : []).map((b) => {
      const bucket = b as Record<string, unknown>
      return {
        id: String(bucket.id ?? ''),
        name: String(bucket.name ?? ''),
        window: String(bucket.window ?? ''),
        remainingFraction: typeof bucket.remaining_fraction === 'number' ? bucket.remaining_fraction : 0,
        resetTime: normalizeUsageResetTime(bucket.reset_time),
        ...(bucket.disabled === true ? { disabled: true } : {}),
      }
    })
    const weeklyExhausted = rawBuckets.some(b => isWeeklyBucket(b) && b.remainingFraction <= 0.005 && !b.disabled)
    const buckets = weeklyExhausted
      ? rawBuckets.map(b => (/5h|hour/i.test(`${b.window} ${b.id}`) ? { ...b, disabled: true } : b))
      : rawBuckets
    return {
      kind,
      name,
      description: String(group.description ?? ''),
      buckets,
    }
  })
}

function normalizeCliQuotaGroups(
  groups: readonly QuotaGroup[],
  models: readonly CatalogModel[] | undefined,
  argonSharedWithGemini: boolean | undefined,
): QuotaGroup[] {
  if (models === undefined || models.length === 0) return [...groups]
  const hasClaudeOrGpt = models.some((m) => {
    const lower = m.id.toLowerCase()
    return lower.startsWith('claude') || lower.startsWith('gpt')
  })
  const out: QuotaGroup[] = []
  for (const group of groups) {
    if (group.kind === 'claude') {
      if (!hasClaudeOrGpt) continue
      out.push({ ...group, name: summarizeClaudeGptLabel(models) })
      continue
    }
    if (group.kind === 'gemini') {
      out.push({ ...group, name: summarizeGeminiLabel(models, argonSharedWithGemini === true) })
      continue
    }
    if (group.kind === 'argon') {
      out.push({ ...group, name: 'Gemini 4 Argon' })
      continue
    }
    out.push({ ...group })
  }
  return out
}

/**
 * Pick the quota group that serves one model family.
 * Checks dedicated Argon groups first (`gemini-4-argon` on Pro), then falls
 * back to Gemini (shared pool on Ultra) or Claude/GPT.
 * @param groups - quota groups.
 * @param model - model family id.
 * @returns the matching group.
 */
export function groupForModel(groups: readonly QuotaGroup[], model: string): QuotaGroup | undefined {
  const lower = model.toLowerCase()
  if (lower.includes('argon')) {
    const argonGroup = groups.find(g => g.kind === 'argon' || (/\bargon\b/i.test(g.name) && g.kind !== 'gemini'))
    if (argonGroup !== undefined) return argonGroup
    return groups.find(g => g.kind === 'gemini' || (/gemini/i.test(g.name) && !/claude|gpt|3p/i.test(g.name))) ?? groups[0]
  }
  const gemini = lower.includes('gemini')
  if (gemini) {
    return groups.find(g => g.kind === 'gemini' || (/gemini/i.test(g.name) && g.kind !== 'argon')) ?? groups[0]
  }
  return groups.find(g => g.kind === 'claude' || /claude|gpt|3p/i.test(g.name)) ?? groups[0]
}

/**
 * Quota family that governs one model id.
 * Argon keeps its own bucket on Pro, so it is not folded into `gemini` here.
 * @param model - model id.
 * @returns the family.
 */
export function quotaFamilyFor(model: string): QuotaFamily {
  if (/argon/i.test(model)) return 'argon'
  if (/claude|gpt|oss/i.test(model)) return 'claude'
  return 'gemini'
}

/** Kind of one group, deriving it from the name when upstream omitted it. */
function groupKindOf(group: QuotaGroup): QuotaFamily {
  return group.kind ?? (/argon/i.test(group.name) ? 'argon' : (/claude|gpt|3p/i.test(group.name) ? 'claude' : 'gemini'))
}

/**
 * Whether this account positively cannot serve Argon. Only evidence counts, so
 * a snapshot that reports no entitlements at all keeps the historic behaviour
 * of trusting the group list; a plan that lists its models, disables Argon by
 * name, or is a Pro/Free plan never borrows the Gemini pool for it.
 * @param snapshot - account snapshot.
 * @param model - requested model id.
 * @returns true when Argon is known to be unavailable.
 */
function argonUnavailable(snapshot: QuotaSnapshot, model: string): boolean {
  if ((snapshot.disabledModels ?? []).some(entry => entry === model || /argon/i.test(entry))) return true
  const entitled = snapshot.availableModels
  if (Array.isArray(entitled) && entitled.length > 0) {
    return !entitled.some(entry => entry.id === model || /argon/i.test(entry.id))
  }
  const tier = snapshot.subscriptionTier
  return tier === 'PRO' || tier === 'FREE'
}

/**
 * Resolve the windows that govern one model on one account.
 *
 * The families do not fall back into each other: a missing Argon bucket on a
 * Pro plan is reported as `model-not-entitled` instead of borrowing the Gemini
 * pool, which is what made an untouched Pro plan read as 100% Argon capacity.
 * Ultra shares one pool between Argon and Gemini, and upstream flags that with
 * `argonSharedWithGemini`, so only that case reuses the Gemini windows.
 * @param snapshot - account snapshot.
 * @param model - requested model id.
 * @returns the focus, including the group when the account may spend the model.
 */
export function resolveModelQuota(snapshot: QuotaSnapshot, model: string): ModelQuotaFocus {
  const groups = Array.isArray(snapshot.groups) ? snapshot.groups : []
  const family = quotaFamilyFor(model)
  const pick = (kind: QuotaFamily): QuotaGroup | undefined => groups.find(group => groupKindOf(group) === kind)

  if (family === 'argon') {
    const argon = pick('argon')
    if (argon !== undefined) return { model, family, entitled: true, group: argon }
    const gemini = pick('gemini')
    const shared = snapshot.argonSharedWithGemini === true || snapshot.subscriptionTier === 'ULTRA' || snapshot.subscriptionTier === 'ENTERPRISE'
    if (gemini !== undefined && (shared || !argonUnavailable(snapshot, model))) {
      return { model, family, entitled: true, group: gemini }
    }
    return {
      model,
      family,
      entitled: false,
      reason: argonUnavailable(snapshot, model) ? 'model-not-entitled' : 'no-groups',
    }
  }
  if (family === 'claude') {
    const claude = pick('claude')
    return claude !== undefined
      ? { model, family, entitled: true, group: claude }
      : { model, family, entitled: false, reason: 'no-groups' }
  }
  const gemini = pick('gemini') ?? (snapshot.argonSharedWithGemini === true || snapshot.subscriptionTier === 'ULTRA' || snapshot.subscriptionTier === 'ENTERPRISE' ? pick('argon') : undefined)
  return gemini !== undefined
    ? { model, family, entitled: true, group: gemini }
    : { model, family, entitled: false, reason: 'no-groups' }
}

/** Cooldown applied to non-force retries after a transient Cloud Code error. */
const TRANSIENT_ERROR_BACKOFF_MS = 60_000
/** Longer cooldown applied to non-force retries after an auth / 403 account block. */
const AUTH_ERROR_BACKOFF_MS = 5 * 60_000

/**
 * Cached quota reader. Every account keeps its own cache entry, error-backoff
 * window, and in-flight request so one account's windows and entitlements never
 * bleed into another and repeated non-force polls never storm upstream after an error.
 */
export class QuotaReader {
  private readonly cached = new Map<string, { snapshot: QuotaSnapshot; at: number }>()
  private readonly errorBackoff = new Map<string, { snapshot: QuotaSnapshot; until: number }>()
  private readonly inflight = new Map<string, Promise<QuotaSnapshot>>()

  /**
   * @param binary - returns the agy executable for CLI fallback.
   * @param run - helper command runner.
   * @param ttlMs - cache lifetime.
   * @param transport - optional Cloud Code HTTP transport override for tests.
   * @param errorBackoffMs - transient error backoff for non-force reads (default 60s).
   * @param authErrorBackoffMs - auth/403 error backoff for non-force reads (default 5m).
   */
  constructor(
    private readonly binary: () => string | undefined,
    private readonly run: CommandRunner,
    private readonly ttlMs: number,
    private readonly transport?: CloudCodeTransport,
    private readonly errorBackoffMs = TRANSIENT_ERROR_BACKOFF_MS,
    private readonly authErrorBackoffMs = AUTH_ERROR_BACKOFF_MS,
  ) {}

  /**
   * Return the cached snapshot of one account without triggering I/O.
   * @param accountId - account key.
   * @returns cached snapshot, if any.
   */
  peekFor(accountId: string): QuotaSnapshot | undefined {
    return this.cached.get(accountId)?.snapshot
  }

  /**
   * Read the quota and entitlement snapshot of one account.
   * @param accountId - account the snapshot belongs to.
   * @param env - environment that selects that account's credential store.
   * @param force - bypass the cache and error backoff.
   * @param layout - optional account layout enabling direct Cloud Code inspection.
   * @param credentialOptions - optional Windows credential routing options.
   * @returns the snapshot; failures resolve as `status: 'error'`.
   */
  async readFor(
    accountId: string,
    env: NodeJS.ProcessEnv,
    force = false,
    layout?: AccountLayout,
    credentialOptions?: ReadCredentialOptions,
  ): Promise<QuotaSnapshot> {
    const now = Date.now()
    const hit = this.cached.get(accountId)
    if (!force && hit !== undefined && now - hit.at < this.ttlMs) return hit.snapshot
    const backedOff = this.errorBackoff.get(accountId)
    if (!force && backedOff !== undefined) {
      if (now < backedOff.until) return backedOff.snapshot
      this.errorBackoff.delete(accountId)
    }
    const running = this.inflight.get(accountId)
    if (!force && running !== undefined) return running
    const pending = this.fetch(accountId, env, layout, credentialOptions, force).finally(() => {
      if (this.inflight.get(accountId) === pending) this.inflight.delete(accountId)
    })
    this.inflight.set(accountId, pending)
    return pending
  }

  /**
   * Read the quota snapshot of the implicit account that uses this machine's login.
   * @param force - bypass the cache.
   * @returns the snapshot.
   */
  read(force = false): Promise<QuotaSnapshot> {
    return this.readFor(SYSTEM_ACCOUNT_ID, {}, force)
  }

  /** Forget every cached snapshot and error backoff, for example after the account list changed. */
  clear(): void {
    this.cached.clear()
    this.errorBackoff.clear()
  }

  /** Forget the cached snapshot and error backoff of one account. */
  clearAccount(accountId: string): void {
    this.cached.delete(accountId)
    this.errorBackoff.delete(accountId)
  }

  private recordError(accountId: string, snapshot: QuotaSnapshot, isAuthFailure: boolean): QuotaSnapshot {
    const duration = isAuthFailure ? this.authErrorBackoffMs : this.errorBackoffMs
    if (duration > 0) {
      this.errorBackoff.set(accountId, { snapshot, until: Date.now() + duration })
    }
    return snapshot
  }

  private async fetch(
    accountId: string,
    env: NodeJS.ProcessEnv,
    layout?: AccountLayout,
    credentialOptions?: ReadCredentialOptions,
    force = false,
  ): Promise<QuotaSnapshot> {
    const cliOnly = credentialOptions?.cliOnlyQuota === true
    const allowCliFallback = credentialOptions?.allowCliFallback !== false
    if (!cliOnly && layout !== undefined) {
      try {
        const inspected = await inspectCloudCodeAccount({
          layout,
          env,
          runCommand: this.run,
          ...(this.transport !== undefined ? { transport: this.transport } : {}),
          ...(credentialOptions !== undefined ? { credentialOptions } : {}),
        })
        if (inspected !== undefined) {
          const snapshot: QuotaSnapshot = {
            status: 'ok',
            updatedAt: new Date().toISOString(),
            groups: inspected.groups,
            subscriptionTier: inspected.subscriptionTier,
            ...(inspected.subscriptionName !== undefined ? { subscriptionName: inspected.subscriptionName } : {}),
            availableModels: inspected.models,
            effortsByModel: inspected.effortsByModel,
            maxTokensByModel: inspected.maxTokensByModel,
            disabledModels: inspected.disabledModels,
            argonSharedWithGemini: inspected.argonSharedWithGemini,
          }
          this.errorBackoff.delete(accountId)
          this.cached.set(accountId, { snapshot, at: Date.now() })
          return snapshot
        }
        if (!allowCliFallback) {
          return this.recordError(accountId, {
            status: 'error',
            updatedAt: new Date().toISOString(),
            groups: [],
            error: 'No saved credential found for this backup account.',
          }, true)
        }
      } catch (cloudError) {
        if (cloudError instanceof VerificationRequiredError) {
          return this.recordError(accountId, {
            status: 'error',
            updatedAt: new Date().toISOString(),
            groups: this.cached.get(accountId)?.snapshot.groups ?? [],
            error: cloudError.message,
            verificationRequired: true,
            ...(cloudError.verificationUrl !== undefined ? { verificationUrl: cloudError.verificationUrl } : {}),
          }, true)
        }
        if (cloudError instanceof TosSuspendedError) {
          return this.recordError(accountId, {
            status: 'error',
            updatedAt: new Date().toISOString(),
            groups: this.cached.get(accountId)?.snapshot.groups ?? [],
            error: cloudError.message,
            tosSuspended: true,
            tosAppealUrl: cloudError.appealUrl,
          }, true)
        }
        // `inspectCloudCodeAccount` throws only after reading a real local OAuth
        // credential and querying Cloud Code PA. Do not redundantly spawn
        // `agy -p /usage` on top of an upstream 401/403/429/network error — doing
        // so doubles upstream traffic, leaks Windows WinCred into backup slots,
        // and leaves behind extra `acp.log.<pid>` files.
        const message = cloudError instanceof Error ? cloudError.message : String(cloudError)
        const isAuth = /HTTP 401|HTTP 403|expired|revoked|forbidden/i.test(message)
        return this.recordError(accountId, {
          status: 'error',
          updatedAt: new Date().toISOString(),
          groups: this.cached.get(accountId)?.snapshot.groups ?? [],
          error: message,
        }, isAuth)
      }
    }

    const binary = this.binary()
    if (binary === undefined) return { status: 'error', updatedAt: new Date().toISOString(), groups: [], error: 'agy binary not resolved yet' }
    const previous = this.cached.get(accountId)?.snapshot
    const shouldFetchModels = cliOnly && (force || previous?.availableModels === undefined || previous.availableModels.length === 0)
    try {
      // Run `/usage` first and `models` sequentially afterwards so two `agy`
      // processes never race to refresh/write the same OAuth credential file,
      // and error paths (ToS/auth/offline) skip the extra `models` spawn.
      const result = await this.run([binary, '-p', '/usage', '--output-format', 'json'], 45_000, env)
      const combinedErrorText = (): string => {
        const parts: string[] = []
        if (result.stderr.trim().length > 0) parts.push(result.stderr.trim())
        if (result.stdout.trim().length > 0) parts.push(result.stdout.trim())
        return parts.join('\n')
      }
      if (result.code !== 0) {
        const rawErr = combinedErrorText() || `agy /usage exited with code ${String(result.code)}`
        const tos = parseTosSuspended(rawErr)
        if (tos !== undefined) {
          return this.recordError(accountId, {
            status: 'error',
            updatedAt: new Date().toISOString(),
            groups: previous?.groups ?? [],
            error: tos.message,
            tosSuspended: true,
            tosAppealUrl: tos.appealUrl,
          }, true)
        }
        const verify = parseVerificationRequired(rawErr)
        if (verify !== undefined) {
          return this.recordError(accountId, {
            status: 'error',
            updatedAt: new Date().toISOString(),
            groups: previous?.groups ?? [],
            error: verify.message,
            verificationRequired: true,
            ...(verify.verificationUrl !== undefined ? { verificationUrl: verify.verificationUrl } : {}),
          }, true)
        }
        const isAuth = /HTTP 401|\b401\b|expired|revoked|unauthorized|invalid_grant|authentication required|not logged in|please sign in/i.test(rawErr)
        return this.recordError(accountId, {
          status: 'error',
          updatedAt: new Date().toISOString(),
          groups: previous?.groups ?? [],
          error: rawErr.slice(0, 400),
        }, isAuth)
      }
      const rawGroups = parseUsage(result.stdout)
      const modelsResult = shouldFetchModels
        ? await this.run([binary, 'models'], 30_000, env).catch(() => undefined)
        : undefined
      const parsedModels = modelsResult !== undefined && modelsResult.code === 0
        ? parseCliModels(modelsResult.stdout)
        : undefined
      const hasCliModels = parsedModels !== undefined && parsedModels.models.length > 0
      const effectiveModels = hasCliModels ? parsedModels.models : previous?.availableModels
      const argonShared = inferArgonSharedWithGemini(rawGroups) ?? previous?.argonSharedWithGemini
      const groups = cliOnly ? normalizeCliQuotaGroups(rawGroups, effectiveModels, argonShared) : rawGroups
      const snapshot: QuotaSnapshot = {
        status: 'ok',
        updatedAt: new Date().toISOString(),
        groups,
        ...(previous?.subscriptionTier !== undefined ? { subscriptionTier: previous.subscriptionTier } : {}),
        ...(previous?.subscriptionName !== undefined ? { subscriptionName: previous.subscriptionName } : {}),
        ...(hasCliModels
          ? {
              availableModels: parsedModels.models,
              effortsByModel: parsedModels.effortsByModel,
              maxTokensByModel: parsedModels.maxTokensByModel,
              disabledModels: [],
            }
          : {
              ...(previous?.availableModels !== undefined ? { availableModels: previous.availableModels } : {}),
              ...(previous?.effortsByModel !== undefined ? { effortsByModel: previous.effortsByModel } : {}),
              ...(previous?.maxTokensByModel !== undefined ? { maxTokensByModel: previous.maxTokensByModel } : {}),
              ...(previous?.disabledModels !== undefined ? { disabledModels: previous.disabledModels } : {}),
            }),
        ...(argonShared !== undefined ? { argonSharedWithGemini: argonShared } : {}),
      }
      this.errorBackoff.delete(accountId)
      this.cached.set(accountId, { snapshot, at: Date.now() })
      return snapshot
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const tos = parseTosSuspended(message)
      if (tos !== undefined) {
        return this.recordError(accountId, {
          status: 'error',
          updatedAt: new Date().toISOString(),
          groups: previous?.groups ?? [],
          error: tos.message,
          tosSuspended: true,
          tosAppealUrl: tos.appealUrl,
        }, true)
      }
      const verify = parseVerificationRequired(message)
      if (verify !== undefined) {
        return this.recordError(accountId, {
          status: 'error',
          updatedAt: new Date().toISOString(),
          groups: previous?.groups ?? [],
          error: verify.message,
          verificationRequired: true,
          ...(verify.verificationUrl !== undefined ? { verificationUrl: verify.verificationUrl } : {}),
        }, true)
      }
      const isAuth = /HTTP 401|\b401\b|expired|revoked|unauthorized|invalid_grant|authentication required|not logged in|please sign in/i.test(message)
      return this.recordError(accountId, {
        status: 'error',
        updatedAt: new Date().toISOString(),
        groups: previous?.groups ?? [],
        error: message,
      }, isAuth)
    }
  }
}
