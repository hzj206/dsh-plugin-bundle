// Unit & integration tests for v0.5.0 upgrades (Directions 3, 4, 5, 6):
// - Direction 3: Gemini 4 Neon & Hydrogen flagship degradation detection, xhigh support,
//   Hydrogen velocity calibration, single-chunk burst protection, and orchestrator exclusion.
// - Direction 4: Anti-risk noise reduction — host-matched Hub User-Agent, QuotaReader error
//   backoff without redundant CLI fallback storm, single-fetch warmup, and zero background
//   probing for disabled / ToS-suspended accounts.
// - Direction 5: cliEnv safe proxy/TLS passthrough, per-account proxy isolation, loopback
//   NO_PROXY enforcement, and host-proxy curl fallback in createCloudCodeTransport.
// - Direction 6: Windows PowerShell loginCommand, normalizeLoginCodeInput (code/URL/quoted),
//   stdout OAuth error surfacing, and isolated Windows login round-trip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { buildLayouts, cliEnv, loginCommand, mergeLoopbackNoProxy } from '../lib/accounts.js'
import { AccountHealthStore } from '../lib/account-health.js'
import { buildHubUserAgent, createCloudCodeTransport } from '../lib/cloudcode.js'
import { writeSlotCredentialFile } from '../lib/credential.js'
import { QuotaReader } from '../lib/quota.js'
import { RouteHealth } from '../lib/route-health.js'
import { AntigravityRuntime, normalizeLoginCodeInput } from '../lib/runtime.js'
import {
  evaluateDegradeFingerprint,
  isGemini4Flagship,
  isHighReasoningEffort,
  isHighSpeedGemini4,
} from '../lib/usage-db.js'

function makeTokenJson(email, access = 'ya29.access', refresh = '1//refresh-perm') {
  return JSON.stringify({
    token: {
      access_token: access,
      token_type: 'Bearer',
      refresh_token: refresh,
      expiry: new Date(Date.now() + 3600_000).toISOString(),
    },
    id_token_email: email,
  })
}

// ============================================================================
// Direction 3: Neon / Hydrogen flagship fingerprint + xhigh + calibration
// ============================================================================

test('D3: isGemini4Flagship covers Neon and Hydrogen while excluding orchestrators and non-flagships', () => {
  assert.equal(isGemini4Flagship('gemini-4-argon'), true)
  assert.equal(isGemini4Flagship('gemini-4-carbon'), true)
  assert.equal(isGemini4Flagship('gemini-4-neon'), true)
  assert.equal(isGemini4Flagship('Gemini 4 Neon (XHigh)'), true)
  assert.equal(isGemini4Flagship('gemini-4-hydrogen'), true)
  assert.equal(isGemini4Flagship('gemini-4-hydrogen-tiered-xhigh'), true)

  assert.equal(isGemini4Flagship('gemini-pro-orchestrator-neon'), false)
  assert.equal(isGemini4Flagship('gemini-pro-orchestrator-g1-pro'), false)
  assert.equal(isGemini4Flagship('gemini-3.8-flash'), false)
  assert.equal(isGemini4Flagship('claude-opus-5-5'), false)
  assert.equal(isGemini4Flagship('gpt-oss-120b-medium'), false)

  assert.equal(isHighSpeedGemini4('gemini-4-hydrogen'), true)
  assert.equal(isHighSpeedGemini4('gemini-4-neon'), false)
  assert.equal(isHighSpeedGemini4('gemini-4-argon'), false)
  assert.equal(isHighReasoningEffort('high'), true)
  assert.equal(isHighReasoningEffort('xhigh'), true)
  assert.equal(isHighReasoningEffort('medium'), false)
  assert.equal(isHighReasoningEffort('low'), false)
})

test('D3: Neon xhigh catches 128K truncation & zero-thought while ignoring buffered single-chunk bursts', () => {
  // 128K head-slice truncation on Neon xhigh -> degraded (+5)
  const truncated = evaluateDegradeFingerprint({
    model: 'gemini-4-neon',
    effort: 'xhigh',
    cwmEstTokens: 320_000,
    step: {
      inputTokens: 3_069, cachedReadTokens: 124_928, outputTokens: 110, thoughtTokens: 20,
      textOutTokens: 90, ttftSeconds: 3.1, streamSeconds: 0.6, wallSeconds: 3.7,
    },
  })
  assert.equal(truncated.evaluated, true)
  assert.equal(truncated.degraded, true)
  assert.ok(truncated.signals.some(s => s.kind === 'context_truncated'))

  // Zero thought under xhigh effort -> degraded (+3)
  const zeroThought = evaluateDegradeFingerprint({
    model: 'gemini-4-neon',
    effort: 'xhigh',
    step: {
      inputTokens: 12_000, cachedReadTokens: 80_123, outputTokens: 180, thoughtTokens: 0,
      textOutTokens: 180, ttftSeconds: 4.2, streamSeconds: 2.0, wallSeconds: 6.2,
    },
  })
  assert.equal(zeroThought.evaluated, true)
  assert.equal(zeroThought.degraded, true)
  assert.ok(zeroThought.signals.some(s => s.kind === 'shallow_thought' && s.points === 3))

  // Real Neon buffered single-chunk delivery (streamSeconds=0.071 -> 12,011 tok/s artifact, wallTps=65)
  const bufferedBurst = evaluateDegradeFingerprint({
    model: 'gemini-4-neon',
    effort: 'xhigh',
    step: {
      inputTokens: 1_500, cachedReadTokens: 93_141, outputTokens: 889, thoughtTokens: 41,
      textOutTokens: 848, ttftSeconds: 13.57, streamSeconds: 0.071, wallSeconds: 13.64,
    },
  })
  assert.equal(bufferedBurst.evaluated, true)
  assert.equal(bufferedBurst.degraded, false)
  assert.equal(bufferedBurst.signals.some(s => s.kind === 'fast_decode'), false)
})

test('D3: Hydrogen calibration keeps healthy high-speed 508K decodes clean while catching truncation and zero-thought', () => {
  // Real healthy Hydrogen sample from production (508K exact cache, 245 wall tok/s, 4.3s TTFT, 299 thought)
  const healthyFast = evaluateDegradeFingerprint({
    model: 'gemini-4-hydrogen',
    effort: 'xhigh',
    step: {
      inputTokens: 11_773, cachedReadTokens: 496_910, outputTokens: 16_176, thoughtTokens: 299,
      textOutTokens: 15_877, ttftSeconds: 4.3, streamSeconds: 61.8, wallSeconds: 66.0,
    },
  })
  assert.equal(healthyFast.evaluated, true)
  assert.equal(healthyFast.degraded, false)
  assert.deepEqual(healthyFast.signals, [])

  // Real 128K truncation on Hydrogen -> still caught (+5)
  const truncated = evaluateDegradeFingerprint({
    model: 'gemini-4-hydrogen',
    effort: 'xhigh',
    cwmEstTokens: 400_000,
    step: {
      inputTokens: 3_069, cachedReadTokens: 124_928, outputTokens: 140, thoughtTokens: 20,
      textOutTokens: 120, ttftSeconds: 3.1, streamSeconds: 0.8, wallSeconds: 3.9,
    },
  })
  assert.equal(truncated.evaluated, true)
  assert.equal(truncated.degraded, true)
  assert.ok(truncated.signals.some(s => s.kind === 'context_truncated'))

  // Zero thought on Hydrogen xhigh -> caught (+3)
  const zeroThought = evaluateDegradeFingerprint({
    model: 'gemini-4-hydrogen',
    effort: 'xhigh',
    isToolStep: true,
    step: {
      inputTokens: 5_000, cachedReadTokens: 50_111, outputTokens: 90, thoughtTokens: 0,
      textOutTokens: 90, ttftSeconds: 2.5, streamSeconds: 0.9, wallSeconds: 3.4,
    },
  })
  assert.equal(zeroThought.degraded, true)
  assert.ok(zeroThought.signals.some(s => s.kind === 'shallow_thought'))

  // RouteHealth records Neon verdict through end of turn
  const health = new RouteHealth(true)
  health.beginTurn()
  health.observeEvaluatedStep({
    model: 'gemini-4-neon',
    effort: 'xhigh',
    step: {
      inputTokens: 3_069, cachedReadTokens: 124_928, outputTokens: 90, thoughtTokens: 15,
      textOutTokens: 75, ttftSeconds: 3.1, streamSeconds: 0.6, wallSeconds: 3.7,
    },
    cwmEstTokens: 350_000,
    isToolStep: false,
    recordUninterceptedHit: true,
  })
  health.finalizeTurnHealth('gemini-4-neon')
  assert.equal(health.snapshot()?.degraded, true)
  assert.equal(health.snapshot()?.model, 'gemini-4-neon')
})

// ============================================================================
// Direction 4: Anti-risk noise reduction (UA, error backoff, disabled/ToS skip)
// ============================================================================

test('D4: buildHubUserAgent aligns os_type and arch with the actual host platform', () => {
  assert.match(buildHubUserAgent('win32', 'x64'), /os_type=windows; arch=amd64/)
  assert.match(buildHubUserAgent('darwin', 'arm64'), /os_type=darwin; arch=arm64/)
  assert.match(buildHubUserAgent('linux', 'x64'), /os_type=linux; arch=amd64/)
})

test('D4: QuotaReader caches errors during backoff without spawning redundant agy -p /usage fallback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-d4-quota-'))
  const [layout] = buildLayouts({
    home,
    accounts: [{ id: 'acc-1', displayName: 'A1', home: '', enabled: true, env: {}, contextWindow: 0, visibleModels: [], priority: 1, weight: 1 }],
  })
  mkdirSync(layout.appDir, { recursive: true })
  writeSlotCredentialFile(layout, makeTokenJson('a1@example.com'), false)

  let cloudCalls = 0
  let cliCalls = 0
  let shouldFail = true
  const reader = new QuotaReader(
    () => '/fake/agy',
    async (argv) => {
      if (argv.includes('/usage')) cliCalls += 1
      return { code: 0, stdout: '{}', stderr: '' }
    },
    300_000,
    async (url) => {
      if (url.includes('loadCodeAssist')) cloudCalls += 1
      if (shouldFail) return { status: 401, body: { error: { message: 'Unauthorized' } } }
      if (url.includes('loadCodeAssist')) return { status: 200, body: { paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }
      if (url.includes('retrieveUserQuotaSummary')) {
        return {
          status: 200,
          body: { userQuotaSummary: { quotaGroups: [{ displayName: 'Gemini', buckets: [{ id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-12-01T00:00:00Z' }] }] } },
        }
      }
      return { status: 200, body: { models: {} } }
    },
    60_000,
    300_000,
  )

  const credOpts = { useWindowsCredentialManager: false, syncFileOnWinCredRead: false, allowCliFallback: true }
  const first = await reader.readFor('acc-1', {}, false, layout, credOpts)
  assert.equal(first.status, 'error')
  assert.equal(cliCalls, 0, 'must not spawn redundant agy -p /usage after direct Cloud Code answered with real credential')
  const callsAfterFirst = cloudCalls
  assert.ok(callsAfterFirst >= 1)

  // Immediate second non-force read hits error backoff -> zero new upstream calls!
  const second = await reader.readFor('acc-1', {}, false, layout, credOpts)
  assert.equal(second.status, 'error')
  assert.equal(cloudCalls, callsAfterFirst, 'non-force read during error backoff must not hit upstream again')

  // Manual force read bypasses backoff and succeeds once recovered
  shouldFail = false
  const third = await reader.readFor('acc-1', {}, true, layout, credOpts)
  assert.equal(third.status, 'ok')
  assert.equal(third.subscriptionTier, 'PRO')
})

test('D4: warmup and refreshAccountEmails skip disabled & ToS-suspended slots and never double-fetch enabled slots', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-d4-warmup-'))
  const accounts = [
    { id: 'acc-active', displayName: 'Active', home: '', enabled: true, env: {}, contextWindow: 0, visibleModels: [], priority: 1, weight: 1 },
    { id: 'acc-disabled', displayName: 'Disabled', home: '', enabled: false, env: {}, contextWindow: 0, visibleModels: [], priority: 999, weight: 1 },
    { id: 'acc-tos', displayName: 'Suspended', home: '', enabled: true, env: {}, contextWindow: 0, visibleModels: [], priority: 2, weight: 1 },
  ]
  const layouts = buildLayouts({ home, accounts })
  for (const l of layouts) {
    mkdirSync(l.appDir, { recursive: true })
    writeSlotCredentialFile(l, makeTokenJson(`${l.id}@example.com`, `tok-${l.id}`), false)
  }

  // Pre-mark acc-tos as ToS suspended in the primary home's account-health.json
  const primaryHome = layouts[0].geminiDir
  const health = new AccountHealthStore(join(primaryHome, 'account-health.json'))
  health.recordTosSuspended('acc-tos', { email: 'acc-tos@example.com', error: 'Terms of Service violation' })

  const loadCallsByToken = new Map()
  const runtime = new AntigravityRuntime({
    platform: 'win32',
    config: {
      provider: 'antigravity', displayName: 'Antigravity', command: 'G:\\agy\\agy.exe', home,
      accounts, configVersion: 2, visibleModels: [], contextWindow: 0, defaultEffort: 'high',
      autoPatch: false, patchScript: '', maxLiveSessions: 4, idleSessionTtlMs: 600_000,
      parkSettleMs: 50, coldSwitchSettleMs: 0, keepAliveMs: 5_000, relayAfterMs: 85_000,
      longDecodeContinuations: 3, warmup: false, quotaTtlMs: 300_000, degradeAction: 'truncation', engineMode: 'bridge',
    },
    spawnAcp: () => { throw new Error('ACP should not spawn when Cloud Code succeeds') },
    runCommand: async () => ({ code: 0, stdout: '1.5.14', stderr: '' }),
    cloudCodeTransport: async (url, headers) => {
      const tok = String(headers.authorization || '').replace(/^Bearer\s+/, '')
      if (url.includes('loadCodeAssist')) {
        loadCallsByToken.set(tok, (loadCallsByToken.get(tok) || 0) + 1)
        return { status: 200, body: { cloudaicompanionProject: 'p1', paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return {
          status: 200,
          body: { userQuotaSummary: { quotaGroups: [{ displayName: 'Gemini', buckets: [{ id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: '2026-12-01T00:00:00Z' }] }] } },
        }
      }
      return {
        status: 200,
        body: {
          agentModelSorts: [{ groups: [{ modelIds: ['gemini-4-neon-high'] }] }],
          models: { 'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)', maxTokens: 1_048_576 } },
        },
      }
    },
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })

  try {
    await runtime.warmup()
    assert.equal(loadCallsByToken.get('tok-acc-active'), 1, 'enabled healthy account should be fetched exactly ONCE on warmup (no double-fetch)')
    assert.equal(loadCallsByToken.get('tok-acc-disabled') || 0, 0, 'disabled account must NEVER be probed on warmup')
    assert.equal(loadCallsByToken.get('tok-acc-tos') || 0, 0, 'ToS-suspended account must NEVER be probed on warmup')

    // Local emails are still populated for all 3 accounts without network calls
    const rows = runtime.accounts()
    assert.equal(rows.find(r => r.id === 'acc-disabled')?.email, 'acc-disabled@example.com')
    assert.equal(rows.find(r => r.id === 'acc-tos')?.email, 'acc-tos@example.com')

    // Calling refreshAccountEmails(true) (as Settings panel does) hits cache for active and skips disabled/ToS
    await runtime.refreshAccountEmails(true)
    assert.equal(loadCallsByToken.get('tok-acc-active'), 1, 'active account reuses 5-min TTL cache')
    assert.equal(loadCallsByToken.get('tok-acc-disabled') || 0, 0)
    assert.equal(loadCallsByToken.get('tok-acc-tos') || 0, 0)
  } finally {
    await runtime.dispose()
  }
})

// ============================================================================
// Direction 5: cliEnv proxy whitelist, loopback NO_PROXY, host-proxy transport
// ============================================================================

test('D5: cliEnv inherits host proxy/TLS vars, isolates account overrides, keeps secrets out, and guards loopback NO_PROXY', () => {
  assert.equal(mergeLoopbackNoProxy('*.corp.local,localhost'), '*.corp.local,localhost,127.0.0.1,::1')

  const parent = {
    USERPROFILE: 'C:\\Users\\me',
    SystemRoot: 'C:\\Windows',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    ALL_PROXY: 'socks5://127.0.0.1:7891',
    NO_PROXY: 'internal.local',
    SSL_CERT_FILE: 'C:\\certs\\corp.pem',
    DEEPSEEK_API_KEY: 'sk-must-not-leak',
    DSH_HOME: 'C:\\Users\\me\\.dsh',
  }

  // Inheriting host proxy preserves it, excludes secrets, and merges loopback NO_PROXY
  const inherited = cliEnv({ HOME: 'C:\\slot\\home' }, 'win32', parent)
  assert.equal(inherited.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(inherited.ALL_PROXY, 'socks5://127.0.0.1:7891')
  assert.equal(inherited.SSL_CERT_FILE, 'C:\\certs\\corp.pem')
  assert.equal(inherited.NO_PROXY, 'internal.local,127.0.0.1,localhost,::1')
  assert.equal(inherited.DEEPSEEK_API_KEY, undefined)
  assert.equal(inherited.DSH_HOME, undefined)

  // Account-specific proxy strips ALL parent proxy vars so ALL_PROXY cannot leak alongside it
  const overridden = cliEnv({ HOME: 'C:\\slot\\home', HTTPS_PROXY: 'http://10.0.0.5:8080' }, 'win32', parent)
  assert.equal(overridden.HTTPS_PROXY, 'http://10.0.0.5:8080')
  assert.equal(overridden.ALL_PROXY, undefined, 'parent ALL_PROXY must be stripped when account sets its own proxy')
  assert.equal(overridden.NO_PROXY, '127.0.0.1,localhost,::1')
  assert.equal(overridden.SSL_CERT_FILE, 'C:\\certs\\corp.pem')
})

test('D5: createCloudCodeTransport routes via curl when host parentEnv declares a proxy and parses CRLF status', async () => {
  const seen = []
  const transport = createCloudCodeTransport(
    async (argv, _timeout, env) => {
      seen.push({ argv, env })
      return { code: 0, stdout: '{"ok":true}\r\n__HTTP_STATUS__:200\r\n', stderr: '' }
    },
    { HTTPS_PROXY: 'http://127.0.0.1:7890' },
  )
  const res = await transport('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', { 'user-agent': 'test' }, '{}', {})
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].argv[0], 'curl')
  assert.equal(seen[0].env.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(seen[0].env.NO_PROXY, '127.0.0.1,localhost,::1')
})

// ============================================================================
// Direction 6: Windows built-in login flow (PowerShell cmd, URL/code parsing, stdout errors)
// ============================================================================

test('D6: loginCommand generates isolated PowerShell commands on Windows and preserves POSIX syntax on POSIX', () => {
  const [sys, work] = buildLayouts({
    home: 'C:\\cache\\agy',
    accounts: [
      { id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 },
      { id: 'acc-2', displayName: 'Work', home: '', enabled: true, env: {}, contextWindow: 0, visibleModels: [], priority: 2, weight: 1 },
    ],
  })

  assert.equal(loginCommand(sys, 'G:\\agy\\agy.exe', 'win32'), "& 'G:\\agy\\agy.exe' acp --login")
  const winIsolated = loginCommand(work, 'G:\\agy\\agy.exe', 'win32')
  assert.match(winIsolated, /\$env:HOME='/)
  assert.match(winIsolated, /\$env:USERPROFILE='/)
  assert.match(winIsolated, /\$env:WSL_INTEROP='dsh-isolated-slot'/)
  assert.match(winIsolated, /--gemini-dir '.*' --app-data-dir 'agy' --login/)

  // Inferred from .exe even without explicit platform arg
  assert.equal(loginCommand(sys, 'G:\\agy\\agy.exe'), "& 'G:\\agy\\agy.exe' acp --login")
})

test('D6: normalizeLoginCodeInput handles bare codes, quotes, query fragments, and full callback URLs', () => {
  assert.equal(normalizeLoginCodeInput('  "4/0AUn6Hd-abc_123"  '), '4/0AUn6Hd-abc_123')
  assert.equal(normalizeLoginCodeInput('code=4%2F0AUn6Hd-xyz&scope=openid'), '4/0AUn6Hd-xyz')
  assert.equal(
    normalizeLoginCodeInput('  https://antigravity.google/oauth-callback?state=st1&code=4%2F0AUn6Hd-url&scope=openid  '),
    'https://antigravity.google/oauth-callback?state=st1&code=4%2F0AUn6Hd-url&scope=openid',
  )
  assert.equal(normalizeLoginCodeInput('4/0AUn6\nHd-split'), '4/0AUn6Hd-split')
})

test('D6: Windows isolated beginLogin + completeLogin surfaces stdout OAuth errors and completes callback URL sign-in', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-d6-login-'))
  const accounts = [
    { id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 },
    { id: 'acc-work', displayName: 'Work', home: '', enabled: true, env: {}, contextWindow: 0, visibleModels: [], priority: 2, weight: 1 },
  ]
  const layouts = buildLayouts({ home, accounts })
  const workLayout = layouts.find(l => l.id === 'acc-work')

  let mode = 'fail-stdout'
  let receivedStdin = ''
  let spawnedArgv = []
  let spawnedEnv = {}

  const fakeBin = join(home, 'agy.exe')
  writeFileSync(fakeBin, 'stub', 'utf8')

  const runtime = new AntigravityRuntime({
    platform: 'win32',
    config: {
      provider: 'antigravity', displayName: 'Antigravity', command: fakeBin, home,
      accounts, configVersion: 2, visibleModels: [], contextWindow: 0, defaultEffort: 'high',
      autoPatch: false, patchScript: '', maxLiveSessions: 4, idleSessionTtlMs: 600_000,
      parkSettleMs: 50, coldSwitchSettleMs: 0, keepAliveMs: 5_000, relayAfterMs: 85_000,
      longDecodeContinuations: 3, warmup: false, quotaTtlMs: 300_000, degradeAction: 'truncation', engineMode: 'bridge',
    },
    spawnAcp: (argv, _cwd, env) => {
      spawnedArgv = [...argv]
      spawnedEnv = { ...(env || {}) }
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const bus = new EventEmitter()
      const exited = new Promise(resolve => bus.once('exit', resolve))
      setTimeout(() => {
        stdout.write('Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=test&state=abc\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n')
      }, 10)
      stdin.on('data', chunk => {
        receivedStdin = chunk.toString()
        if (mode === 'fail-stdout') {
          stdout.write('\ncouldn\'t log in: token exchange failed: oauth2: "invalid_grant" "Bad Request"\n')
          stdout.end()
          bus.emit('exit', { code: 1, signal: null })
        } else {
          // Simulate agy.exe writing isolated file token under <appDir>/antigravity-oauth-token
          mkdirSync(workLayout.appDir, { recursive: true })
          writeFileSync(join(workLayout.appDir, 'antigravity-oauth-token'), makeTokenJson('work-new@example.com'), 'utf8')
          stdout.write('\nLogged in successfully.\n')
          stdout.end()
          bus.emit('exit', { code: 0, signal: null })
        }
      })
      return {
        stdin,
        stdout,
        exited,
        terminate: () => bus.emit('exit', { code: null, signal: 'SIGTERM' }),
        stderrTail: () => '',
      }
    },
    runCommand: async () => ({ code: 1, stdout: '', stderr: '' }),
    cloudCodeTransport: async (url) => {
      if (url.includes('loadCodeAssist')) return { status: 200, body: { paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }
      if (url.includes('retrieveUserQuotaSummary')) return { status: 200, body: { userQuotaSummary: { quotaGroups: [] } } }
      return { status: 200, body: { models: {} } }
    },
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })

  try {
    // 1. Failed token exchange printed to STDOUT (empty stderr) is surfaced verbatim
    const ticket1 = await runtime.beginLogin('acc-work')
    assert.match(ticket1.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth/)
    assert.match(ticket1.command, /\$env:WSL_INTEROP='dsh-isolated-slot'/)
    assert.equal(spawnedEnv.WSL_INTEROP, 'dsh-isolated-slot')
    assert.ok(spawnedArgv.includes('--gemini-dir'))
    const failRes = await runtime.completeLogin('acc-work', '4/0BAD_CODE')
    assert.equal(failRes.ok, false)
    assert.match(failRes.error, /invalid_grant/, 'Windows stdout OAuth error must be surfaced')

    // 2. Successful sign-in with full callback URL persists and mirrors token
    mode = 'succeed'
    await runtime.beginLogin('acc-work')
    const okRes = await runtime.completeLogin('acc-work', '  "https://antigravity.google/oauth-callback?state=abc&code=4%2F0GOOD_CODE"  ')
    assert.equal(okRes.ok, true)
    assert.equal(okRes.email, 'work-new@example.com')
    assert.equal(receivedStdin, 'https://antigravity.google/oauth-callback?state=abc&code=4%2F0GOOD_CODE\n')
    const mirroredPath = join(workLayout.homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    assert.equal(existsSync(mirroredPath), true, 'isolated token must be mirrored into CLI home dir')
    assert.match(readFileSync(mirroredPath, 'utf8'), /work-new@example\.com/)
  } finally {
    await runtime.dispose()
  }
})
