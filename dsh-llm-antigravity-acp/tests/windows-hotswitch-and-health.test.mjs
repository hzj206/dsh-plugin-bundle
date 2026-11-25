// Unit & integration tests for Windows single-active hot-switch, permanent
// OAuth credential import/backup/refresh persistence, verification required
// (403), ToS suspension (403) + appeal/recheck, and subscription tier downgrade
// alerting.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  AccountHealthStore,
  DEFAULT_TOS_APPEAL_URL,
  readActiveAccountRecord,
  writeActiveAccountRecord,
} from '../lib/account-health.js'
import { accountEnv, buildLayouts, cliEnv } from '../lib/accounts.js'
import {
  inspectCloudCodeAccount,
  parseTosSuspended,
  parseVerificationRequired,
  TosSuspendedError,
  VerificationRequiredError,
} from '../lib/cloudcode.js'
import { readStoredCredentialFileRaw, writeStoredCredentialFile } from '../lib/credential.js'
import { AntigravityRemote } from '../lib/remote.js'
import { AntigravityRuntime } from '../lib/runtime.js'
import {
  parseImportedCredential,
  parseOAuthBlob,
  readWindowsCredential,
  updateTokenJsonAfterRefresh,
  writeWindowsCredential,
} from '../lib/wincred.js'

const fakeBinary = join(dirname(fileURLToPath(import.meta.url)), 'fake-agy.mjs')
const runtimes = []
after(async () => {
  for (const rt of runtimes) await rt.dispose()
})

function makeOAuthJson(email, accessToken, refreshToken = `1//refresh-${email}`, expiryIso = new Date(Date.now() + 3600_000).toISOString()) {
  const payload = {
    id_token_email: email,
    token: {
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      expiry: expiryIso,
    },
  }
  return JSON.stringify(payload)
}

function makeAgyCredBackup(email, accessToken, refreshToken = `1//refresh-${email}`) {
  const raw = makeOAuthJson(email, accessToken, refreshToken)
  return JSON.stringify({
    target: 'gemini:antigravity',
    userName: 'antigravity',
    email,
    blobBase64: Buffer.from(raw, 'utf8').toString('base64'),
  })
}

// ── 1. WinCred & Permanent Credential Parsing ────────────────────────────────

test('parseOAuthBlob and parseImportedCredential handle plain JSON, go-keyring-base64, JWT email, and agy_cred.ps1 backup', () => {
  const jwtPayload = Buffer.from(JSON.stringify({ email: 'jwt-user@example.com' })).toString('base64url')
  const jwtOnly = JSON.stringify({ access_token: 'tok-jwt', refresh_token: '1//perm', id_token: `hdr.${jwtPayload}.sig` })
  const parsedJwt = parseOAuthBlob(`\uFEFFgo-keyring-base64:${Buffer.from(jwtOnly, 'utf8').toString('base64')}`)
  assert.ok(parsedJwt)
  assert.equal(parsedJwt.email, 'jwt-user@example.com')
  assert.equal(parsedJwt.accessToken, 'tok-jwt')
  assert.equal(parsedJwt.refreshToken, '1//perm')
  assert.equal(parsedJwt.hasRefreshToken, true)

  const agyBackup = makeAgyCredBackup('backup@example.com', 'tok-b', '1//perm-b')
  const parsedBackup = parseImportedCredential(agyBackup)
  assert.ok(parsedBackup)
  assert.equal(parsedBackup.email, 'backup@example.com')
  assert.equal(parsedBackup.hasRefreshToken, true)

  const noRefresh = parseOAuthBlob(makeOAuthJson('short@example.com', 'tok-s', ''))
  assert.ok(noRefresh)
  assert.equal(noRefresh.hasRefreshToken, false)
})

test('updateTokenJsonAfterRefresh rotates access_token and preserves permanent refresh_token and metadata', () => {
  const original = JSON.stringify({
    id_token_email: 'keep@example.com',
    project_id: 'proj-123',
    token: {
      access_token: 'old-access',
      refresh_token: '1//permanent-refresh',
      expiry: '2020-01-01T00:00:00.000Z',
    },
  })
  const updated = updateTokenJsonAfterRefresh(original, { accessToken: 'new-access', expiresInSeconds: 3600 })
  assert.ok(updated)
  const parsed = JSON.parse(updated)
  assert.equal(parsed.id_token_email, 'keep@example.com')
  assert.equal(parsed.project_id, 'proj-123')
  assert.equal(parsed.token.access_token, 'new-access')
  assert.equal(parsed.token.refresh_token, '1//permanent-refresh')
  assert.ok(Date.parse(parsed.token.expiry) > Date.now())
})

test('writeWindowsCredential enforces permanent refresh_token, email guard, and passes secret strictly via env (never argv)', async () => {
  let seenArgv = []
  let seenEnv = {}
  const fakeRun = async (argv, _timeout, env) => {
    seenArgv = argv
    seenEnv = env ?? {}
    return { code: 0, stdout: 'AGY_WINCRED_WRITTEN\n', stderr: '' }
  }

  // Rejects blob without refresh_token
  await assert.rejects(
    () => writeWindowsCredential(fakeRun, makeOAuthJson('a@example.com', 'tok-a', '')),
    /refresh_token/,
  )

  // Rejects mismatched expectedEmail
  await assert.rejects(
    () => writeWindowsCredential(fakeRun, makeOAuthJson('a@example.com', 'tok-a', '1//r-a'), { expectedEmail: 'b@example.com' }),
    /does not match expected account/,
  )

  // Writes valid credential strictly via env var
  const secretToken = '1//super-secret-refresh-token'
  const raw = makeOAuthJson('ok@example.com', 'tok-ok', secretToken)
  const written = await writeWindowsCredential(fakeRun, raw, { expectedEmail: 'ok@example.com' })
  assert.equal(written.email, 'ok@example.com')
  assert.equal(written.hasRefreshToken, true)
  assert.equal(seenArgv.join(' ').includes(secretToken), false, 'secret must never appear in process argv')
  assert.equal(Buffer.from(seenEnv.AGY_WINCRED_PAYLOAD_B64, 'base64').toString('utf8'), raw)

  // Read round-trip
  const readBack = await readWindowsCredential(async () => ({
    code: 0,
    stdout: `AGY_WINCRED_B64:${Buffer.from(raw, 'utf8').toString('base64')}\n`,
    stderr: '',
  }))
  assert.equal(readBack, raw)

  const missing = await readWindowsCredential(async () => ({
    code: 0,
    stdout: 'AGY_WINCRED_NOT_FOUND\n',
    stderr: '',
  }))
  assert.equal(missing, undefined)
})

// ── 2. AccountHealthStore & Tier Downgrade / ToS Persistence ─────────────────

test('AccountHealthStore detects PRO -> FREE downgrade, ignores email changes, clears on upgrade, and persists across reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-health-test-'))
  const file = join(dir, 'account-health.json')
  const store = new AccountHealthStore(file)

  store.observeSubscription('acc-1', { email: 'alice@example.com', tier: 'PRO', subscriptionName: 'Google AI Pro', modelCount: 5, at: '2026-11-20T00:00:00.000Z' })
  assert.equal(store.get('acc-1')?.downgradeAlert, undefined)

  // Same email drops PRO -> FREE => triggers downgrade alert
  store.observeSubscription('acc-1', { email: 'alice@example.com', tier: 'FREE', subscriptionName: 'Free', modelCount: 2, at: '2026-11-21T00:00:00.000Z' })
  const afterDrop = store.get('acc-1')
  assert.equal(afterDrop?.downgradeAlert?.fromTier, 'PRO')
  assert.equal(afterDrop?.downgradeAlert?.toTier, 'FREE')
  assert.equal(afterDrop?.downgradeAlert?.fromModels, 5)
  assert.equal(afterDrop?.downgradeAlert?.toModels, 2)
  assert.equal(afterDrop?.downgradeAlert?.acknowledged, false)
  assert.equal(afterDrop?.tierHistory.length, 2)

  // Acknowledge dismisses banner while keeping history, persisted to disk
  store.acknowledgeDowngrade('acc-1')
  const reloaded = new AccountHealthStore(file)
  assert.equal(reloaded.get('acc-1')?.downgradeAlert?.acknowledged, true)
  assert.equal(reloaded.get('acc-1')?.tierHistory.length, 2)

  // Upgrade back to PRO clears stale downgradeAlert
  reloaded.observeSubscription('acc-1', { email: 'alice@example.com', tier: 'PRO', modelCount: 5, at: '2026-11-22T00:00:00.000Z' })
  assert.equal(reloaded.get('acc-1')?.downgradeAlert, undefined)

  // Switching the slot to a DIFFERENT email never emits a false downgrade alert
  reloaded.observeSubscription('acc-1', { email: 'newuser@example.com', tier: 'FREE', modelCount: 2, at: '2026-11-22T01:00:00.000Z' })
  assert.equal(reloaded.get('acc-1')?.downgradeAlert, undefined)

  // ToS suspension persists & clears cleanly
  reloaded.recordTosSuspended('acc-2', { email: 'banned@example.com', error: 'violation of Terms of Service' })
  const reloaded2 = new AccountHealthStore(file)
  assert.equal(reloaded2.get('acc-2')?.tosSuspended, true)
  assert.equal(reloaded2.get('acc-2')?.tosAppealUrl, DEFAULT_TOS_APPEAL_URL)
  reloaded2.clearTosSuspended('acc-2')
  assert.equal(new AccountHealthStore(file).get('acc-2')?.tosSuspended, undefined)

  // Active account record round-trip
  const activeFile = join(dir, 'active-account.json')
  writeActiveAccountRecord(activeFile, { accountId: 'acc-2', email: 'bob@example.com', switchedAt: '2026-11-22T02:00:00.000Z' })
  assert.deepEqual(readActiveAccountRecord(activeFile), {
    accountId: 'acc-2',
    email: 'bob@example.com',
    switchedAt: '2026-11-22T02:00:00.000Z',
  })
})

// ── 3. Cloud Code 403 Detection & Token Refresh Persistence ──────────────────

test('parseVerificationRequired, parseTosSuspended, and inspectCloudCodeAccount classify 403 and persist refreshed tokens', async () => {
  const verifyBody = {
    error: {
      code: 403,
      message: 'Verify your account to continue.',
      details: [{
        reason: 'VALIDATION_REQUIRED',
        metadata: {
          validation_url: 'https://accounts.google.com/signin/continue?sarp=1&scc=1',
          validation_error_message: 'Please verify your Google account.',
        },
      }],
    },
  }
  const parsedV = parseVerificationRequired(verifyBody)
  assert.equal(parsedV?.verificationUrl, 'https://accounts.google.com/signin/continue?sarp=1&scc=1')
  assert.equal(parsedV?.message, 'Please verify your Google account.')

  const tosBody = {
    error: {
      code: 403,
      message: 'This service has been disabled in this account for violation of Terms of Service. Submit an appeal to continue using this product.',
    },
  }
  const parsedTos = parseTosSuspended(tosBody)
  assert.equal(parsedTos?.appealUrl, DEFAULT_TOS_APPEAL_URL)

  const appDir = mkdtempSync(join(tmpdir(), 'agy-cc-refresh-'))
  const expiredRaw = makeOAuthJson('refresh@example.com', 'expired-tok', '1//keep-forever', '2020-01-01T00:00:00.000Z')
  writeStoredCredentialFile(appDir, expiredRaw, false)

  const layout = { id: 'acc-r', label: 'R', system: false, enabled: true, root: appDir, declaredHome: '', homeDir: appDir, geminiDir: appDir, appDir, workspace: appDir, env: {}, contextWindow: 0, visibleModels: [], priority: 1, weight: 1 }
  let refreshedCalls = 0
  const transport = async (url, headers) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      refreshedCalls += 1
      return { status: 200, body: { access_token: 'fresh-access-tok', expires_in: 3600 } }
    }
    if (url.includes('loadCodeAssist')) {
      assert.equal(headers.authorization ?? headers.Authorization, 'Bearer fresh-access-tok')
      return { status: 200, body: { currentTier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, cloudaicompanionProject: 'p-1' } }
    }
    if (url.includes('retrieveUserQuotaSummary')) {
      return { status: 200, body: { groups: [] } }
    }
    if (url.includes('fetchAvailableModels')) {
      return { status: 200, body: { models: { 'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-29T00:00:00Z' } } } } }
    }
    return { status: 404, body: {} }
  }

  const inspection = await inspectCloudCodeAccount({
    layout,
    runCommand: async () => ({ code: 1, stdout: '', stderr: '' }),
    transport,
    platform: 'linux',
  })
  assert.equal(refreshedCalls, 1)
  assert.equal(inspection?.subscriptionTier, 'PRO')
  const savedAfter = parseOAuthBlob(readStoredCredentialFileRaw(appDir) ?? '')
  assert.equal(savedAfter?.accessToken, 'fresh-access-tok')
  assert.equal(savedAfter?.refreshToken, '1//keep-forever', 'permanent refresh_token must survive access token refresh')

  // Verify VerificationRequiredError and TosSuspendedError are thrown on 403
  await assert.rejects(
    () => inspectCloudCodeAccount({
      layout,
      runCommand: async () => ({ code: 1, stdout: '', stderr: '' }),
      platform: 'linux',
      transport: async (url) => url.includes('loadCodeAssist')
        ? { status: 403, body: verifyBody }
        : { status: 200, body: {} },
    }),
    err => err instanceof VerificationRequiredError && err.verificationUrl === 'https://accounts.google.com/signin/continue?sarp=1&scc=1',
  )

  await assert.rejects(
    () => inspectCloudCodeAccount({
      layout,
      runCommand: async () => ({ code: 1, stdout: '', stderr: '' }),
      platform: 'linux',
      transport: async (url) => url.includes('loadCodeAssist')
        ? { status: 403, body: tosBody }
        : { status: 200, body: {} },
    }),
    err => err instanceof TosSuspendedError && err.appealUrl === DEFAULT_TOS_APPEAL_URL,
  )
})

// ── 4. Windows Single-Active Hot-Switch, Backup/Import, Verification, ToS & Downgrade End-to-End ──

test('Windows concurrent multi-account mode: snapshot, import, per-session switch/unpin, restart persistence, verification/ToS recheck, and downgrade ack', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-win-e2e-'))
  const aliceRaw = makeOAuthJson('alice@example.com', 'tok-alice', '1//refresh-alice')
  const bobBackup = makeAgyCredBackup('bob@example.com', 'tok-bob', '1//refresh-bob')
  const bobBackupFile = join(home, 'bob-backup.json')
  writeFileSync(bobBackupFile, bobBackup, 'utf8')

  // Simulated Windows Credential Manager store
  let winCredBlob = aliceRaw
  let aliceState = 'pro' // 'pro' | 'verify' | 'free' | 'tos'
  let bobProbeOk = false
  let bobTos = false
  const persistedSettings = []

  const runCommand = async (argv, _timeout, env) => {
    if (argv[0] === 'powershell.exe') {
      if (env?.AGY_WINCRED_PAYLOAD_B64) {
        winCredBlob = Buffer.from(env.AGY_WINCRED_PAYLOAD_B64, 'base64').toString('utf8')
        return { code: 0, stdout: 'AGY_WINCRED_WRITTEN\n', stderr: '' }
      }
      if (!winCredBlob) return { code: 0, stdout: 'AGY_WINCRED_NOT_FOUND\n', stderr: '' }
      return {
        code: 0,
        stdout: `AGY_WINCRED_B64:${Buffer.from(winCredBlob, 'utf8').toString('base64')}\n`,
        stderr: '',
      }
    }
    if (argv.includes('--version')) return { code: 0, stdout: 'agy 1.0.0', stderr: '' }
    if (argv.includes('-p') && argv.includes('Reply with OK')) {
      return bobProbeOk
        ? { code: 0, stdout: 'OK\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'This service has been disabled in this account for violation of Terms of Service.' }
    }
    return { code: 0, stdout: '{}', stderr: '' }
  }

  const cloudCodeTransport = async (url, headers) => {
    const auth = headers.authorization ?? headers.Authorization ?? ''
    if (auth.includes('tok-alice')) {
      if (aliceState === 'verify' && url.includes('fetchAvailableModels')) {
        return {
          status: 403,
          body: {
            error: {
              code: 403,
              message: 'Verify your account to continue.',
              details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: 'https://accounts.google.com/verify-alice' } }],
            },
          },
        }
      }
      if (url.includes('loadCodeAssist')) {
        return {
          status: 200,
          body: aliceState === 'free'
            ? { currentTier: { id: 'free-tier', name: 'Free' } }
            : { currentTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } },
        }
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return {
          status: 200,
          body: {
            groups: [{
              name: 'Gemini Models',
              buckets: [{ id: 'gemini-weekly', name: 'Weekly', remainingFraction: 0.85, resetTime: '2026-11-29T00:00:00Z' }],
            }],
          },
        }
      }
      if (url.includes('fetchAvailableModels')) {
        return {
          status: 200,
          body: {
            models: aliceState === 'free'
              ? { 'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-29T00:00:00Z' } } }
              : {
                'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-29T00:00:00Z' } },
                'claude-opus-4-6-thinking': { displayName: 'Claude Opus 4.6', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-29T00:00:00Z' } },
              },
          },
        }
      }
    }
    if (auth.includes('tok-bob')) {
      if (bobTos && url.includes('loadCodeAssist')) {
        return {
          status: 403,
          body: { error: { code: 403, message: 'This service has been disabled in this account for violation of Terms of Service.' } },
        }
      }
      if (url.includes('loadCodeAssist')) {
        return { status: 200, body: { currentTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } } }
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return {
          status: 200,
          body: {
            groups: [{
              name: 'Gemini Models',
              buckets: [{ id: 'gemini-weekly', name: 'Weekly', remainingFraction: 0.95, resetTime: '2026-11-29T00:00:00Z' }],
            }],
          },
        }
      }
      if (url.includes('fetchAvailableModels')) {
        return {
          status: 200,
          body: {
            models: {
              'gemini-4-argon': { displayName: 'Gemini 4 Argon', quotaInfo: { remainingFraction: 0.95, resetTime: '2026-11-29T00:00:00Z' } },
              'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.95, resetTime: '2026-11-29T00:00:00Z' } },
            },
          },
        }
      }
    }
    return { status: 404, body: {} }
  }

  const defaultMachineProfile = [{
    id: 'default', displayName: '', home: '', enabled: true, env: {},
    contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1,
  }]
  const createRuntime = (accounts = defaultMachineProfile) => {
    const rt = new AntigravityRuntime({
      platform: 'win32',
      cloudCodeTransport,
      config: {
        provider: 'antigravity', displayName: 'Antigravity', command: fakeBinary, home,
        accounts,
        contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
        maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
        longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000,
      },
      spawnAcp: () => { throw new Error('unexpected spawn') },
      runCommand,
      readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
      canReadImages: () => true,
      log: { info: () => undefined, warn: () => undefined },
      onModelsChanged: () => undefined,
    })
    runtimes.push(rt)
    return rt
  }

  const runtime = createRuntime()
  const ctx = new Context()
  ctx.provide('settings', {
    writable: true,
    update: async (ns, patch) => { persistedSettings.push({ ns, patch }) },
  })
  const remote = new AntigravityRemote(ctx, { runtime, settingsNs: 'dsh-llm-antigravity-acp' })

  // 1. Initial Windows status has `default` active and reads Alice from WinCred
  await runtime.refreshAccountEmails(true)
  const initialStatus = remote.status()
  assert.equal(initialStatus.platform, 'win32')
  assert.equal(initialStatus.activeAccountId, 'default')
  assert.equal(initialStatus.accounts[0].active, true)
  assert.equal(initialStatus.accounts[0].email, 'alice@example.com')
  assert.equal(initialStatus.accounts[0].hasRefreshToken, true)
  assert.equal(initialStatus.accounts[0].subscriptionTier, 'PRO')

  // 2. Snapshot current WinCred reuses matching email slot (no duplicate row)
  const snapRes = await remote.snapshotAccount()
  assert.equal(snapRes.accountId, 'default')
  assert.equal(snapRes.email, 'alice@example.com')
  assert.equal(snapRes.created, false)

  // 3. Import Bob's backup by local file path — creates backup slot WITHOUT changing WinCred
  const impRes = await remote.importCredential({ displayName: 'Bob Ultra', content: bobBackupFile })
  assert.equal(impRes.created, true)
  assert.equal(impRes.email, 'bob@example.com')
  assert.equal(impRes.hasRefreshToken, true)
  const bobId = impRes.accountId
  assert.equal(persistedSettings.length, 1, 'newly created imported slot must be persisted to settings')
  assert.equal(parseOAuthBlob(winCredBlob)?.email, 'alice@example.com', 'importing backup must not overwrite active WinCred')

  // Inactive Bob row reports ULTRA from its OWN isolated token file, NOT Alice's PRO
  const bobRowBefore = impRes.status.accounts.find(a => a.id === bobId)
  assert.equal(bobRowBefore?.active, false)
  assert.equal(bobRowBefore?.subscriptionTier, 'ULTRA')
  assert.equal(bobRowBefore?.hasRefreshToken, true)

  // Rejects importing credential lacking permanent refresh_token
  await assert.rejects(
    () => remote.importCredential({ content: makeOAuthJson('noref@example.com', 'tok-nr', '') }),
    /refresh_token/,
  )

  // 4. Disable Bob first, then pin sess-beta to Bob while pinning sess-alpha to Alice (default)
  //    => auto-enables Bob, keeps WinCred untouched on Alice, and lets BOTH sessions resolve their own account concurrently!
  await remote.configure({
    accounts: impRes.status.accounts.map(a => ({
      id: a.id, displayName: a.label === 'This Mac' ? '' : a.label, home: a.home,
      enabled: a.id === bobId ? false : true, env: a.env, contextWindow: a.contextWindow,
      ...(a.system ? { system: true } : {}), visibleModels: a.visibleModels, priority: a.priority, weight: a.weight,
    })),
  })

  // Verify Windows non-system isolation env (`USERPROFILE` + `WSL_INTEROP`) and mixed-case `cliEnv` dedupe
  const [sysLayout, bobLayout] = buildLayouts({
    home,
    accounts: impRes.status.accounts.map(a => ({
      id: a.id, displayName: a.label === 'This Mac' ? '' : a.label, home: a.home,
      enabled: true, env: a.env, contextWindow: a.contextWindow,
      ...(a.system ? { system: true } : {}), visibleModels: a.visibleModels, priority: a.priority, weight: a.weight,
    })),
  })
  const sysEnv = accountEnv(sysLayout, 'win32')
  const bobEnv = accountEnv(bobLayout, 'win32')
  assert.equal(sysEnv.WSL_INTEROP, undefined, 'system slot keeps native WinCred without WSL_INTEROP')
  assert.equal(bobEnv.WSL_INTEROP, 'dsh-isolated-slot', 'non-system Windows slot sets WSL_INTEROP for file-based token isolation')
  assert.equal(bobEnv.USERPROFILE, bobLayout.homeDir, 'non-system Windows slot sets USERPROFILE to isolated home')
  const mergedWinEnv = cliEnv(bobEnv, 'win32', { UserProfile: 'C:\\Users\\RealUser', SystemRoot: 'C:\\Windows' })
  assert.equal(mergedWinEnv.USERPROFILE, bobLayout.homeDir)
  assert.equal(mergedWinEnv.UserProfile, undefined, 'mixed-case UserProfile from parent must not shadow overlay USERPROFILE')

  // Pin sess-alpha -> default (Alice PRO) and sess-beta -> bobId (Bob ULTRA)
  await remote.switchAccount({ accountId: 'default', sessionId: 'sess-alpha' })
  const betaPinnedStatus = await remote.switchAccount({ accountId: bobId, sessionId: 'sess-beta' })
  assert.equal(parseOAuthBlob(winCredBlob)?.email, 'alice@example.com', 'concurrent per-session switch must not overwrite WinCred')
  assert.equal(betaPinnedStatus.multiAccountMode, 'concurrent')
  assert.equal(betaPinnedStatus.accounts.find(a => a.id === bobId)?.enabled, true, 'switching to a disabled slot must auto-enable it')
  assert.equal(betaPinnedStatus.pinnedSessions?.['sess-alpha'], 'default')
  assert.equal(betaPinnedStatus.pinnedSessions?.['sess-beta'], bobId)
  assert.ok(betaPinnedStatus.availableModels.some(m => m.id === 'gemini-4-argon'), 'union catalog exposes Bob ULTRA models concurrently')

  // Concurrent per-session quota attribution: sess-alpha reads Alice (PRO), sess-beta reads Bob (ULTRA)
  const alphaQuota = await remote.quota({ model: 'gemini-3.8-flash', sessionId: 'sess-alpha' })
  const betaQuota = await remote.quota({ model: 'gemini-3.8-flash', sessionId: 'sess-beta' })
  assert.equal(alphaQuota.accountId, 'default')
  assert.equal(alphaQuota.subscriptionTier, 'PRO')
  assert.equal(betaQuota.accountId, bobId)
  assert.equal(betaQuota.subscriptionTier, 'ULTRA')

  // Mid-conversation one-click switch on sess-alpha moves ONLY sess-alpha to Bob, then unpin restores auto
  await remote.switchAccount({ accountId: bobId, sessionId: 'sess-alpha' })
  assert.equal((await remote.quota({ model: 'gemini-3.8-flash', sessionId: 'sess-alpha' })).accountId, bobId)
  const unpinnedStatus = await remote.switchAccount({ sessionId: 'sess-alpha', clear: true })
  assert.equal(unpinnedStatus.pinnedSessions?.['sess-alpha'], undefined)
  assert.equal(unpinnedStatus.pinnedSessions?.['sess-beta'], bobId, 'unpinning sess-alpha leaves sess-beta untouched')

  // Global default switch (no sessionId) updates activeAccountId without touching WinCred
  const switchedStatus = await remote.switchAccount({ accountId: bobId })
  assert.equal(switchedStatus.activeAccountId, bobId)
  assert.equal(parseOAuthBlob(winCredBlob)?.email, 'alice@example.com', 'global default switch does not clobber WinCred')
  assert.equal(switchedStatus.accounts.find(a => a.id === bobId)?.active, true)
  assert.equal(switchedStatus.accounts.find(a => a.id === 'default')?.active, false)
  assert.ok(switchedStatus.accounts.find(a => a.id === bobId)?.quotaSummary?.primary !== undefined, 'cached quotaSummary populated for composer switcher')

  // 5. Restart persistence: new runtime restores BOTH activeAccountId and per-session pinnedSessions
  const restarted = createRuntime(switchedStatus.accounts.map(a => ({
    id: a.id, displayName: a.label === 'This Mac' ? '' : a.label, home: a.home,
    enabled: a.enabled, env: a.env, contextWindow: a.contextWindow,
    ...(a.system ? { system: true } : {}), visibleModels: a.visibleModels, priority: a.priority, weight: a.weight,
  })))
  assert.equal(restarted.status().activeAccountId, bobId)
  assert.equal(restarted.status().pinnedSessions?.['sess-beta'], bobId)
  assert.equal(restarted.status().pinnedSessions?.['sess-alpha'], undefined)

  // 6. Verification required (403) on Alice + recheck clears once resolved
  aliceState = 'verify'
  const verifyRecheck = await remote.recheckAccount({ accountId: 'default' })
  assert.equal(verifyRecheck.quota.verificationRequired, true)
  assert.equal(verifyRecheck.quota.verificationUrl, 'https://accounts.google.com/verify-alice')
  assert.equal(verifyRecheck.status.accounts.find(a => a.id === 'default')?.verificationRequired, true)

  // Alice finishes verification, but subscription dropped PRO -> FREE!
  aliceState = 'free'
  const dropRecheck = await remote.recheckAccount({ accountId: 'default' })
  assert.equal(dropRecheck.quota.verificationRequired, undefined)
  assert.equal(dropRecheck.quota.downgradeAlert?.fromTier, 'PRO')
  assert.equal(dropRecheck.quota.downgradeAlert?.toTier, 'FREE')
  const aliceAfterDrop = dropRecheck.status.accounts.find(a => a.id === 'default')
  assert.equal(aliceAfterDrop?.downgradeAlert?.fromTier, 'PRO')
  assert.equal(aliceAfterDrop?.downgradeAlert?.toTier, 'FREE')
  assert.ok((aliceAfterDrop?.tierHistory?.length ?? 0) >= 2)

  // Acknowledge downgrade banner hides alert while retaining tierHistory
  const acked = remote.ackDowngrade({ accountId: 'default' })
  assert.equal(acked.accounts.find(a => a.id === 'default')?.downgradeAlert, undefined)
  assert.ok((acked.accounts.find(a => a.id === 'default')?.tierHistory?.length ?? 0) >= 2)

  // 7. ToS suspension on active Bob + recheck probes generation once and clears when appeal succeeds
  bobTos = true
  const tosRecheck = await remote.recheckAccount({ accountId: bobId })
  assert.equal(tosRecheck.quota.tosSuspended, true)
  assert.equal(tosRecheck.quota.tosAppealUrl, DEFAULT_TOS_APPEAL_URL)
  assert.equal(tosRecheck.status.accounts.find(a => a.id === bobId)?.tosSuspended, true)

  // Appeal approved: Cloud Code returns 200 AND explicit probe succeeds => clears tosSuspended
  bobTos = false
  bobProbeOk = true
  const recovered = await remote.recheckAccount({ accountId: bobId })
  assert.equal(recovered.status.accounts.find(a => a.id === bobId)?.tosSuspended, undefined)
  assert.equal(recovered.quota.tosSuspended, undefined)

  // 8. Restart hydrates persisted tier + per-account entitledModels even before live probing
  const persistedHealth = new AccountHealthStore(join(home, 'account-health.json'))
  assert.ok((persistedHealth.get(bobId)?.lastAvailableModels?.length ?? 0) > 0)
  const coldRestart = createRuntime(recovered.status.accounts.map(a => ({
    id: a.id, displayName: a.label === 'This Mac' ? '' : a.label, home: a.home,
    enabled: a.id === bobId ? false : a.enabled, env: a.env, contextWindow: a.contextWindow,
    ...(a.system ? { system: true } : {}), visibleModels: a.visibleModels, priority: a.priority, weight: a.weight,
  })))
  const coldBob = coldRestart.accounts().find(a => a.id === bobId)
  assert.equal(coldBob?.subscriptionTier, 'ULTRA')
  assert.ok((coldBob?.entitledModels?.length ?? 0) > 0, 'disabled account retains its own persisted upstream entitledModels across restarts')

  // 9. Persisted authError survives restarts and clears on fresh OK observation
  const errHealthPath = join(home, 'auth-health-check.json')
  const h1 = new AccountHealthStore(errHealthPath)
  h1.recordAuthError('acc-expired', { email: 'expired@example.com', error: 'Antigravity OAuth token expired or revoked (HTTP 401)' })
  const h2 = new AccountHealthStore(errHealthPath)
  assert.match(h2.get('acc-expired')?.authError ?? '', /HTTP 401/)
  h2.observeSubscription('acc-expired', { email: 'expired@example.com', tier: 'PRO', modelCount: 8 })
  assert.equal(h2.get('acc-expired')?.authError, undefined)

  // 10. ACP-discovered orchestrators survive Cloud Code quota refreshes without flapping
  const orchHome = mkdtempSync(join(tmpdir(), 'agy-orch-merge-'))
  const orchRt = new AntigravityRuntime({
    platform: 'win32',
    config: {
      provider: 'antigravity', displayName: 'Antigravity', command: fakeBinary, home: orchHome,
      accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
      configVersion: 2, visibleModels: [], contextWindow: 0, defaultEffort: 'high',
      autoPatch: false, patchScript: join(orchHome, 'missing.py'), maxLiveSessions: 4, idleSessionTtlMs: 600_000,
      parkSettleMs: 50, keepAliveMs: 5_000, longDecodeContinuations: 3, warmup: false, quotaTtlMs: 5_000,
    },
    spawnAcp: () => { throw new Error('unused') },
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  runtimes.push(orchRt)
  const defaultSlot = orchRt.slots.get('default')
  orchRt.observeSlotCatalog(defaultSlot, [{
    id: 'model',
    category: 'model',
    options: [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
      { value: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)' },
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ],
  }])
  orchRt.applyQuotaToSlot(defaultSlot, {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    subscriptionTier: 'PRO',
    subscriptionName: 'Google AI Pro',
    argonSharedWithGemini: true,
    groups: [],
    availableModels: [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ],
    disabledModels: [],
  })
  assert.deepEqual(defaultSlot.availableModels.map(m => m.id), [
    'gemini-4-neon',
    'gemini-4-argon',
    'gemini-pro-orchestrator-neon',
    'gemini-pro-orchestrator-argon',
    'gemini-3.8-flash',
  ], 'eligible ACP orchestrators survive subsequent Cloud Code quota refreshes')

  // If Argon is later disabled by upstream, Argon orchestrator is dropped automatically
  orchRt.applyQuotaToSlot(defaultSlot, {
    status: 'ok',
    updatedAt: new Date().toISOString(),
    subscriptionTier: 'PRO',
    groups: [],
    availableModels: [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ],
    disabledModels: ['gemini-4-argon'],
  })
  assert.deepEqual(defaultSlot.availableModels.map(m => m.id), [
    'gemini-4-neon',
    'gemini-pro-orchestrator-neon',
    'gemini-3.8-flash',
  ], 'disallowed Argon orchestrator is pruned when Argon is disabled')
})

test('Safe credential export round-trips without returning secrets over RPC, import enforces 1 MiB cap, and switching/routing reject suspended, auth-expired, or opening-turn states', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-export-guard-'))
  const secretRefresh = '1//perm-export-secret-token'
  const secretAccess = 'ya29.export-secret-access'
  const rt = new AntigravityRuntime({
    platform: 'win32',
    config: {
      provider: 'antigravity', displayName: 'Antigravity', command: fakeBinary, home,
      accounts: [
        { id: 'default', displayName: 'Primary', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 },
        { id: 'acc-tos', displayName: 'Suspended', home: '', enabled: false, env: {}, contextWindow: 0, visibleModels: [], priority: 2, weight: 1 },
        { id: 'acc-exp', displayName: 'Expired', home: '', enabled: false, env: {}, contextWindow: 0, visibleModels: [], priority: 3, weight: 1 },
      ],
      configVersion: 2, visibleModels: [], contextWindow: 0, defaultEffort: 'high',
      autoPatch: false, patchScript: '', maxLiveSessions: 4, idleSessionTtlMs: 600_000,
      parkSettleMs: 100, coldSwitchSettleMs: 0, keepAliveMs: 5_000, relayAfterMs: 85_000,
      longDecodeContinuations: 3, warmup: false, quotaTtlMs: 300_000, degradeAction: 'off', engineMode: 'bridge',
    },
    spawnAcp: () => { throw new Error('no ACP needed') },
    runCommand: async () => ({ code: 0, stdout: 'AGY_WINCRED_NOT_FOUND\n', stderr: '' }),
    cloudCodeTransport: async (url) => {
      if (url.includes('loadCodeAssist')) return { status: 200, body: { cloudaicompanionProject: 'p1', paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }
      if (url.includes('retrieveUserQuotaSummary')) return { status: 200, body: { userQuotaSummary: { quotaGroups: [] } } }
      return { status: 200, body: { agentModelSorts: [{ groups: [{ modelIds: ['gemini-4-neon-high'] }] }], models: { 'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)', maxTokens: 1_048_576 } } } }
    },
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  runtimes.push(rt)
  const ctx = new Context()
  const remote = new AntigravityRemote(ctx, { runtime: rt, settingsNs: 'dsh-llm-antigravity-acp' })

  // Seed default slot with a permanent credential
  const defaultSlot = rt.slots.get('default')
  writeStoredCredentialFile(defaultSlot.layout.appDir, makeOAuthJson('owner@example.com', secretAccess, secretRefresh), false)
  defaultSlot.email = 'owner@example.com'
  defaultSlot.hasRefreshToken = true

  // 1. Export writes local agy_cred.ps1 JSON and NEVER returns any token over RPC
  const exported = await remote.exportCredential({ accountId: 'default' })
  assert.equal(exported.accountId, 'default')
  assert.equal(exported.email, 'owner@example.com')
  assert.equal(exported.hasRefreshToken, true)
  assert.ok(existsSync(exported.filePath), 'exported backup file must exist on disk')
  const rpcJson = JSON.stringify(exported)
  assert.equal(rpcJson.includes(secretAccess), false, 'RPC export response must never contain access_token')
  assert.equal(rpcJson.includes(secretRefresh), false, 'RPC export response must never contain refresh_token')
  assert.equal(rpcJson.includes('blobBase64'), false, 'RPC export response must never contain blobBase64')

  // Exported file round-trips cleanly through importCredential
  const backupDisk = JSON.parse(readFileSync(exported.filePath, 'utf8'))
  assert.equal(backupDisk.email, 'owner@example.com')
  assert.equal(backupDisk.target, 'gemini:antigravity')
  const reimported = await remote.importCredential({ content: exported.filePath })
  assert.equal(reimported.accountId, 'default')
  assert.equal(reimported.email, 'owner@example.com')
  assert.equal(reimported.hasRefreshToken, true)

  // 2. Oversized file (> 1 MiB) is rejected before reading into memory
  const giantFile = join(home, 'too-big.json')
  writeFileSync(giantFile, 'x'.repeat(1_050_000), 'utf8')
  await assert.rejects(() => remote.importCredential({ content: giantFile }), /1 MiB|过大/)

  // 3. Suspended & auth-expired accounts cannot be switched into (and remain disabled) or scheduled
  const tosSlot = rt.slots.get('acc-tos')
  tosSlot.email = 'tos@example.com'
  tosSlot.hasRefreshToken = true
  rt.health.recordTosSuspended('acc-tos', { email: 'tos@example.com', error: 'ToS violation' })

  const expSlot = rt.slots.get('acc-exp')
  expSlot.email = 'exp@example.com'
  expSlot.hasRefreshToken = true
  expSlot.authError = 'OAuth token revoked (HTTP 401)'
  rt.health.recordAuthError('acc-exp', { email: 'exp@example.com', error: expSlot.authError })

  assert.equal(rt.slotCanServeModel('acc-tos', 'gemini-4-neon'), false)
  assert.equal(rt.slotCanServeModel('acc-exp', 'gemini-4-neon'), false)
  assert.equal(rt.slotCanServeModel('default', 'gemini-4-neon'), true)

  await assert.rejects(() => remote.switchAccount({ accountId: 'acc-tos', sessionId: 'sess-guard' }), /ToS|停用/)
  await assert.rejects(() => remote.switchAccount({ accountId: 'acc-exp', sessionId: 'sess-guard' }), /凭据已失效/)
  await assert.rejects(() => remote.switchAccount({ accountId: 'acc-tos' }), /ToS|停用/)
  await assert.rejects(() => remote.switchAccount({ accountId: 'acc-exp' }), /凭据已失效/)
  assert.equal(rt.accounts().find(a => a.id === 'acc-tos')?.enabled, false, 'failed switch must not auto-enable ToS account')
  assert.equal(rt.accounts().find(a => a.id === 'acc-exp')?.enabled, false, 'failed switch must not auto-enable expired account')

  // 4. Switching is also blocked while a conversation is mid-open (`conv.opening === true`)
  const openingConv = rt.createConversation('sess-opening|main', 'main', 'sess-opening')
  openingConv.opening = true
  await assert.rejects(() => remote.switchAccount({ accountId: 'default', sessionId: 'sess-opening' }), /正在生成回复/)
  openingConv.opening = false
  const okSwitch = await remote.switchAccount({ accountId: 'default', sessionId: 'sess-opening' })
  assert.equal(okSwitch.pinnedSessions?.['sess-opening'], 'default')
})
