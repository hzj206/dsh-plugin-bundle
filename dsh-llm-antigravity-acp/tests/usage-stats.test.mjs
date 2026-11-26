// Tests for the local read-only token usage ledger (src/usage-stats.ts):
// Protobuf billing decode, enum auto-learning, incremental caching, range and
// account filters, variant grouping, standalone CLI inclusion, and reference
// API cost estimates. Every fixture is a real SQLite file shaped exactly like
// `agy`'s conversation store; nothing touches the network or OAuth credentials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  colorGroupForModel,
  estimateApiCostUsd,
  localDayKey,
  referenceApiRatesFor,
  STANDALONE_CLI_SOURCE_KEY,
  UsageLedgerStore,
} from '../lib/usage-stats.js'
import { INVOCATIONS, parseUsageStatsRequest } from '../lib/remote.js'

// ── Minimal Protobuf encoder mirroring agy's `steps.metadata` / `gen_metadata` ──

function varint(n) {
  let v = BigInt(n)
  const out = []
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
  } while (v > 0n)
  return out
}
const tag = (field, wire) => varint((field << 3) | wire)
const intField = (field, value) => [...tag(field, 0), ...varint(value)]
const bytesField = (field, payload) => [...tag(field, 2), ...varint(payload.length), ...payload]
const strField = (field, s) => bytesField(field, [...Buffer.from(s, 'utf8')])
const timestamp = (sec, nanos = 0) => [...intField(1, sec), ...intField(2, nanos)]

/** `ModelUsageStats` submessage (field 9): f1 model, f2 in, f3 out, f4 cw, f5 cr, f7 request id, f9 thought, f10 text. */
function usageBytes({ model, input, output, cacheWrite = 0, cacheRead = 0, thought = 0, textOut = 0, requestId }) {
  const out = []
  if (model !== undefined) out.push(...intField(1, model))
  out.push(...intField(2, input), ...intField(3, output), ...intField(4, cacheWrite), ...intField(5, cacheRead))
  if (requestId) out.push(...strField(7, requestId))
  out.push(...intField(9, thought), ...intField(10, textOut))
  return out
}

/** A complete `steps.metadata` blob: f1 start, f7 end, f9 usage, f11 model enum. */
function stepMetadata({ startSec, model, input, output, cacheWrite, cacheRead, thought, textOut, requestId }) {
  return [
    ...bytesField(1, timestamp(startSec, 500_000_000)),
    ...intField(3, 2),
    ...bytesField(6, timestamp(startSec + 1)),
    ...bytesField(7, timestamp(startSec + 20)),
    ...bytesField(9, usageBytes({ model, input, output, cacheWrite, cacheRead, thought, textOut, requestId })),
    ...intField(11, model),
    ...strField(12, randomUUID()),
  ]
}

/** A `gen_metadata.data` blob: f1 chat model (f1.3 enum, f1.19 model id, f1.21 display name), f2 step indices. */
function genMetadata({ model, modelId, displayName, stepIdxs }) {
  const chat = [
    ...intField(3, model),
    ...bytesField(4, usageBytes({ model, input: 0, output: 0 })),
    ...strField(19, modelId),
    ...bytesField(20, [...strField(1, 'model_enum'), ...strField(2, `MODEL_PLACEHOLDER_M${model}`)]),
    ...strField(21, displayName),
  ]
  const idxs = []
  for (const idx of stepIdxs) idxs.push(...varint(idx))
  return [...bytesField(1, chat), ...bytesField(2, idxs), ...strField(4, randomUUID())]
}

const STEPS_DDL = 'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))'
const GEN_DDL = 'CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))'

/** Write one conversation DB with billed steps and (optionally) gen_metadata rows. */
function writeConversationDb(dir, name, { steps, gens = [] }) {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, name))
  try {
    db.exec(STEPS_DDL)
    db.exec(GEN_DDL)
    const insertStep = db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)')
    steps.forEach((s, i) => insertStep.run(i + 1, s.stepType ?? 15, s.status ?? 3, Buffer.from(stepMetadata(s))))
    const insertGen = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
    gens.forEach((g, i) => {
      const buf = Buffer.from(genMetadata(g))
      insertGen.run(i, buf, buf.length)
    })
  } finally {
    db.close()
  }
  return join(dir, name)
}

// Local-time anchors: "now" is Thursday 2026-11-26 noon, so this week is Mon 11/23 – Sun 11/29.
const NOW = new Date(2026, 10, 26, 12, 0, 0).getTime()
const at = (month, day, hour) => new Date(2026, month - 1, day, hour).getTime() / 1000
const MON = at(11, 23, 10)
const WED = at(11, 25, 9)
const THU = at(11, 26, 8)
const SAT_PREV = at(11, 21, 20)
const OCT = at(10, 20, 8)

const NEON_XHIGH = 1535
const NEON_HIGH = 1532
const HYDROGEN_HIGH = 1525
const CLAUDE_OPUS = 1402
const UNKNOWN_ENUM = 9999

const mainSteps = [
  // Neon XHigh: two completed steps on Monday.
  { startSec: MON, model: NEON_XHIGH, input: 1000, output: 300, cacheRead: 4000, thought: 200, textOut: 100, requestId: 'req-1' },
  { startSec: MON + 60, model: NEON_XHIGH, input: 500, output: 100, cacheRead: 1000, thought: 50, textOut: 50, requestId: 'req-2' },
  // A replayed row with the same request id must be deduplicated.
  { startSec: MON + 90, model: NEON_XHIGH, input: 999, output: 999, cacheRead: 999, thought: 0, textOut: 0, requestId: 'req-2' },
  // Hydrogen High on Wednesday, via step_type 23 (still a completed, billed generation).
  { startSec: WED, stepType: 23, model: HYDROGEN_HIGH, input: 2000, output: 800, cacheRead: 6000, thought: 300, textOut: 500, requestId: 'req-3' },
  // Neon High today.
  { startSec: THU, model: NEON_HIGH, input: 300, output: 120, cacheRead: 0, thought: 20, textOut: 100, requestId: 'req-4' },
  // A failed step (status 6) carries counters but is not consumption.
  { startSec: THU + 10, status: 6, model: NEON_HIGH, input: 7000, output: 700, cacheRead: 7000, thought: 0, textOut: 0, requestId: 'req-failed' },
  // An all-zero row is skipped.
  { startSec: THU + 20, model: NEON_HIGH, input: 0, output: 0, cacheRead: 0, thought: 0, textOut: 0, requestId: 'req-zero' },
]
const prevWeekSteps = [
  // Claude Opus 5.5 High last Saturday (inside the month and the 30-day window, outside this week).
  { startSec: SAT_PREV, model: CLAUDE_OPUS, input: 1500, output: 500, cacheRead: 3000, thought: 200, textOut: 300, requestId: 'req-5' },
]
const octoberSteps = [
  { startSec: OCT, model: NEON_XHIGH, input: 10_000, output: 1_000, cacheRead: 50_000, thought: 400, textOut: 600, requestId: 'req-old' },
]
const unknownSteps = [
  // A model enum the built-in table does not know; learned from gen_metadata below.
  { startSec: WED + 3600, model: UNKNOWN_ENUM, input: 400, output: 200, cacheRead: 1600, thought: 100, textOut: 100, requestId: 'req-6' },
]
const unknownGens = [
  { model: UNKNOWN_ENUM, modelId: 'gemini-9-quantum-high', displayName: 'Gemini 9 Quantum (High)', stepIdxs: [1] },
]
const workSteps = [
  { startSec: MON, model: HYDROGEN_HIGH, input: 100, output: 50, cacheRead: 900, thought: 10, textOut: 40, requestId: 'req-w' },
]
const cliSteps = [
  { startSec: MON, model: NEON_XHIGH, input: 1000, output: 100, cacheRead: 0, thought: 50, textOut: 50, requestId: 'req-cli' },
]

// Expected week totals, derived by hand from the fixtures above.
const NEON = { calls: 3, input: 1800, cacheRead: 5000, output: 520, thought: 270, textOut: 250, total: 7320 }
const HYDROGEN_MAIN = { calls: 1, input: 2000, cacheRead: 6000, output: 800, total: 8800 }
const QUANTUM = { calls: 1, input: 400, cacheRead: 1600, output: 200, total: 2200 }
const HYDROGEN_WORK = { calls: 1, input: 100, cacheRead: 900, output: 50, total: 1050 }
const CLI_NEON = { calls: 1, input: 1000, cacheRead: 0, output: 100, total: 1100 }
const CLAUDE = { calls: 1, input: 1500, cacheRead: 3000, output: 500, total: 5000 }
const sum = (...rows) => rows.reduce((acc, r) => ({
  calls: acc.calls + r.calls, input: acc.input + r.input, cacheRead: acc.cacheRead + r.cacheRead,
  output: acc.output + r.output, total: acc.total + r.total,
}), { calls: 0, input: 0, cacheRead: 0, output: 0, total: 0 })
const DEFAULT_WEEK = sum(NEON, HYDROGEN_MAIN, QUANTUM)
const ALL_WEEK = sum(DEFAULT_WEEK, HYDROGEN_WORK)
const round4 = (n) => Math.round(n * 10_000) / 10_000

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agy-usage-'))
  const home = join(root, 'home')
  const base = join(root, 'cache', 'antigravity-acp')
  const accounts = [
    {
      accountId: 'default', label: 'This Mac', email: 'main@example.com', system: true,
      appDir: join(base, 'agy'), geminiDir: base, homeDir: home,
    },
    {
      accountId: 'acc-work', label: 'Work', email: 'work@example.com', system: false,
      appDir: join(base, 'accounts', 'acc-work', 'gemini', 'agy'),
      geminiDir: join(base, 'accounts', 'acc-work', 'gemini'),
      homeDir: join(base, 'accounts', 'acc-work', 'home'),
    },
  ]
  writeConversationDb(join(accounts[0].appDir, 'conversations'), 'a.db', { steps: mainSteps })
  writeConversationDb(join(accounts[0].appDir, 'conversations'), 'b.db', { steps: prevWeekSteps })
  writeConversationDb(join(accounts[0].appDir, 'conversations'), 'old.db', { steps: octoberSteps })
  writeConversationDb(join(accounts[0].appDir, 'conversations'), 'new-model.db', { steps: unknownSteps, gens: unknownGens })
  writeConversationDb(join(accounts[1].appDir, 'conversations'), 'w.db', { steps: workSteps })
  // The user's standalone `agy` CLI history lives under the real home directory.
  writeConversationDb(join(home, '.gemini', 'antigravity-cli', 'conversations'), 'cli.db', { steps: cliSteps })
  const ledgerPath = join(base, 'usage-ledger.json')
  const store = () => new UsageLedgerStore(ledgerPath, { platform: process.platform, now: () => NOW, scanTtlMs: 60_000 })
  return { root, base, home, accounts, ledgerPath, store }
}

test('reference API list prices follow the published rate cards, including the Dec 1 Carbon/Argon step', () => {
  assert.deepEqual(referenceApiRatesFor('gemini-4-neon'), { inputPerM: 3, cacheReadPerM: 0.15, cacheWritePerM: 3, outputPerM: 15 })
  assert.deepEqual(referenceApiRatesFor('gemini-pro-orchestrator-neon'), { inputPerM: 3, cacheReadPerM: 0.15, cacheWritePerM: 3, outputPerM: 15 })
  assert.deepEqual(referenceApiRatesFor('gemini-4-hydrogen', '2026-11-26'), { inputPerM: 1.5, cacheReadPerM: 0.075, cacheWritePerM: 1.5, outputPerM: 7.5 })
  assert.deepEqual(referenceApiRatesFor('gemini-4-argon', '2026-11-30'), { inputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 2, outputPerM: 10 })
  assert.deepEqual(referenceApiRatesFor('gemini-4-carbon', '2026-12-01'), { inputPerM: 4, cacheReadPerM: 0.2, cacheWritePerM: 4, outputPerM: 20 })
  assert.deepEqual(referenceApiRatesFor('gemini-pro-orchestrator-g1-pro', '2026-12-01'), { inputPerM: 4, cacheReadPerM: 0.2, cacheWritePerM: 4, outputPerM: 20 })
  assert.deepEqual(referenceApiRatesFor('gemini-3.8-flash'), { inputPerM: 0.75, cacheReadPerM: 0.075, cacheWritePerM: 0.75, outputPerM: 3.75 })
  assert.deepEqual(referenceApiRatesFor('claude-opus-5-5'), { inputPerM: 4, cacheReadPerM: 0.2, cacheWritePerM: 5, outputPerM: 20 })
  assert.deepEqual(referenceApiRatesFor('claude-sonnet-5-5'), { inputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 2.5, outputPerM: 10 })
  assert.deepEqual(referenceApiRatesFor('gpt-oss-120b-medium'), { inputPerM: 0.15, cacheReadPerM: 0.075, cacheWritePerM: 0.15, outputPerM: 0.6 })
  assert.deepEqual(referenceApiRatesFor('some-unknown-model'), { inputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 2, outputPerM: 10 })

  const cost = estimateApiCostUsd({ familyId: 'gemini-4-neon', inputTokens: 1500, cacheReadTokens: 5000, cacheWriteTokens: 0, outputTokens: 400 })
  assert.equal(cost.estimatedUsd, 0.01125)
  assert.equal(cost.cacheSavingsUsd, 0.01425)
  const claude = estimateApiCostUsd({ familyId: 'claude-opus-5-5', inputTokens: 1500, cacheReadTokens: 3000, cacheWriteTokens: 1000, outputTokens: 500 })
  assert.equal(claude.estimatedUsd, (1500 * 4 + 3000 * 0.2 + 1000 * 5 + 500 * 20) / 1_000_000)
})

test('model families map to semantic color groups and local day keys use the calendar date', () => {
  assert.equal(colorGroupForModel('gemini-4-neon'), 'neon')
  assert.equal(colorGroupForModel('gemini-4-hydrogen'), 'hydrogen')
  assert.equal(colorGroupForModel('gemini-flash-worker-agy'), 'hydrogen')
  assert.equal(colorGroupForModel('gemini-4-argon'), 'argon')
  assert.equal(colorGroupForModel('gemini-4-carbon'), 'carbon')
  assert.equal(colorGroupForModel('gemini-pro-orchestrator-neon'), 'orchestrator')
  assert.equal(colorGroupForModel('gemini-pro-orchestrator-argon'), 'argon', 'the Argon orchestrator takes the Argon hue')
  assert.equal(colorGroupForModel('gemini-pro-orchestrator-g1-pro'), 'argon')
  assert.equal(colorGroupForModel('gemini-pro-orchestrator'), 'orchestrator')
  assert.equal(colorGroupForModel('gemini-3.8-flash'), 'flash')
  assert.equal(colorGroupForModel('claude-opus-5-5'), 'claude')
  assert.equal(colorGroupForModel('gpt-oss-120b-medium'), 'gpt')
  assert.equal(colorGroupForModel('mystery'), 'other')
  assert.equal(localDayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})

test('cold scan aggregates billed steps per day and model, dedupes request ids, skips failed steps, and learns unknown enums', () => {
  const f = fixture()
  try {
    const snap = f.store().query(f.accounts, { range: 'week', groupBy: 'family', force: true })
    assert.equal(snap.status, 'ok')
    assert.equal(snap.rangeLabel, '11/23 – 11/29')
    assert.equal(snap.scannedFiles, 6, 'every .db under every account dir plus the standalone CLI dir is scanned once')
    assert.equal(snap.cachedFiles, 0)
    assert.equal(snap.hasStandaloneCli, true)
    assert.equal(snap.includeStandaloneCli, false, 'standalone CLI history is opt-in')
    assert.equal(snap.accountId, 'all')

    // Totals cover both configured accounts and exclude the standalone CLI history.
    assert.equal(snap.totals.calls, ALL_WEEK.calls)
    assert.equal(snap.totals.inputTokens, ALL_WEEK.input)
    assert.equal(snap.totals.cacheReadTokens, ALL_WEEK.cacheRead)
    assert.equal(snap.totals.outputTokens, ALL_WEEK.output)
    assert.equal(snap.totals.totalTokens, ALL_WEEK.total)
    // Cache hit rate is prompt-side only: cache reads over input + cache reads + cache writes.
    assert.equal(snap.totals.cacheHitRate, round4(ALL_WEEK.cacheRead / (ALL_WEEK.input + ALL_WEEK.cacheRead)))

    // Ranking is by total tokens, with the work account's Hydrogen folded into its family.
    assert.deepEqual(snap.models.map(m => m.familyId), ['gemini-4-hydrogen', 'gemini-4-neon', 'gemini-9-quantum'])
    const hydrogen = snap.models[0]
    assert.equal(hydrogen.calls, 2)
    assert.equal(hydrogen.totalTokens, HYDROGEN_MAIN.total + HYDROGEN_WORK.total)
    assert.equal(hydrogen.colorGroup, 'hydrogen')
    assert.equal(hydrogen.familyName, 'Gemini 4 Hydrogen')
    assert.equal(hydrogen.share, round4(hydrogen.totalTokens / ALL_WEEK.total))
    assert.ok(!snap.models.some(m => m.familyId === 'claude-opus-5-5'), 'last Saturday is outside this week')

    // The machine account alone: the replayed request id is dropped, the failed and
    // all-zero rows are skipped, and XHigh + High collapse into one Neon family.
    const main = f.store().query(f.accounts, { range: 'week', accountId: 'default', force: true })
    const neon = main.models.find(m => m.familyId === 'gemini-4-neon')
    assert.equal(neon.calls, NEON.calls)
    assert.equal(neon.inputTokens, NEON.input)
    assert.equal(neon.cacheReadTokens, NEON.cacheRead)
    assert.equal(neon.outputTokens, NEON.output)
    assert.equal(neon.thoughtTokens, NEON.thought)
    assert.equal(neon.textOutTokens, NEON.textOut)
    assert.equal(neon.totalTokens, NEON.total)
    assert.equal(neon.name, 'Gemini 4 Neon')
    // 1800*3 + 5000*0.15 + 520*15 = 13,950 per million.
    assert.equal(neon.estimatedUsd, 0.014)
    assert.equal(neon.cacheSavingsUsd, 0.0143)
    // The unknown enum was learned from gen_metadata and named by it.
    const quantum = main.models.find(m => m.familyId === 'gemini-9-quantum')
    assert.ok(quantum, 'an unknown model enum is resolved through gen_metadata')
    assert.equal(quantum.name, 'Gemini 9 Quantum')
    assert.equal(quantum.calls, 1)
    assert.equal(quantum.colorGroup, 'other')
    assert.equal(main.totals.calls, DEFAULT_WEEK.calls)
    assert.equal(main.totals.totalTokens, DEFAULT_WEEK.total)

    // Chart: Monday through Sunday, today marked, future days empty.
    assert.deepEqual(snap.daily.map(d => d.day), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'])
    assert.deepEqual(snap.daily.map(d => d.inRange), [true, true, true, true, true, true, true])
    assert.deepEqual(snap.daily.map(d => d.isToday), [false, false, false, true, false, false, false])
    assert.deepEqual(snap.daily.map(d => d.isFuture), [false, false, false, false, true, true, true])
    assert.equal(snap.daily[1].totalTokens, 0)
    assert.equal(snap.daily[1].segments.length, 0)
    const monday = snap.daily[0]
    assert.equal(monday.totalTokens, NEON.total - 420 + HYDROGEN_WORK.total)
    assert.deepEqual(monday.segments.map(s => [s.familyId, s.totalTokens]), [['gemini-4-neon', 6900], ['gemini-4-hydrogen', 1050]])
    assert.equal(monday.segments[0].name, 'Gemini 4 Neon')
    const wednesday = snap.daily[2]
    assert.equal(wednesday.totalTokens, HYDROGEN_MAIN.total + QUANTUM.total)
    assert.deepEqual(wednesday.segments.map(s => s.familyId), ['gemini-4-hydrogen', 'gemini-9-quantum'])
    assert.equal(snap.daily[3].totalTokens, 420)

    // Per-account summaries over the same window; the work account is isolated.
    const byAccount = Object.fromEntries(snap.accounts.map(a => [a.accountId, a]))
    assert.equal(byAccount.default.totalTokens, DEFAULT_WEEK.total)
    assert.equal(byAccount.default.email, 'main@example.com')
    assert.equal(byAccount.default.system, true)
    assert.equal(byAccount['acc-work'].totalTokens, HYDROGEN_WORK.total)
    assert.equal(byAccount['acc-work'].system, false)
    assert.equal(byAccount.default.share, round4(DEFAULT_WEEK.total / ALL_WEEK.total))
    assert.equal(byAccount['acc-work'].share, round4(HYDROGEN_WORK.total / ALL_WEEK.total))

    // The ledger is persisted for warm restarts, including the learned enum.
    assert.ok(existsSync(f.ledgerPath))
    const persisted = JSON.parse(readFileSync(f.ledgerPath, 'utf8'))
    assert.equal(persisted.version, 1)
    assert.equal(persisted.knownEnums[String(UNKNOWN_ENUM)].modelId, 'gemini-9-quantum-high')
    assert.equal(Object.keys(persisted.files).length, 6)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('warm queries reuse the ledger (no rescans), and a fresh store instance resumes from disk', () => {
  const f = fixture()
  try {
    const first = f.store().query(f.accounts, { range: 'week', force: true })
    assert.equal(first.scannedFiles, 6)
    // A brand-new store has an empty in-memory cache, but the on-disk ledger makes it warm.
    const again = f.store().query(f.accounts, { range: 'week' })
    assert.equal(again.scannedFiles, 0)
    assert.equal(again.cachedFiles, 6)
    assert.equal(again.totals.totalTokens, first.totals.totalTokens)
    assert.deepEqual(again.models.map(m => m.name), first.models.map(m => m.name))
    assert.ok(again.elapsedMs < 50, `warm aggregation is fast (took ${again.elapsedMs}ms)`)
    // The non-forced TTL also suppresses a directory walk inside the same instance.
    const warm = f.store()
    warm.query(f.accounts, { range: 'week', force: true })
    const third = warm.query(f.accounts, { range: 'week' })
    const fourth = warm.query(f.accounts, { range: 'week' })
    assert.equal(third.scannedFiles, 0)
    assert.equal(fourth.scannedFiles, 0)
    assert.equal(fourth.cachedFiles, 6)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('a changed conversation file is rescanned by mtime/size signature and a deleted one is kept in history', () => {
  const f = fixture()
  try {
    const first = f.store().query(f.accounts, { range: 'week', force: true })
    const hydrogenBefore = first.models.find(m => m.familyId === 'gemini-4-hydrogen').totalTokens
    // Append a completed step to the work account's DB and bump its mtime.
    const dbPath = join(f.accounts[1].appDir, 'conversations', 'w.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)')
        .run(99, 15, 3, Buffer.from(stepMetadata({ startSec: MON + 5, model: HYDROGEN_HIGH, input: 10, output: 5, cacheRead: 85, thought: 0, textOut: 5, requestId: 'req-w2' })))
    } finally {
      db.close()
    }
    const future = new Date(Date.now() + 5000)
    utimesSync(dbPath, future, future)
    const second = f.store().query(f.accounts, { range: 'week', force: true })
    assert.equal(second.accounts.find(a => a.accountId === 'acc-work').totalTokens, HYDROGEN_WORK.total + 100)
    assert.equal(second.models.find(m => m.familyId === 'gemini-4-hydrogen').totalTokens, hydrogenBefore + 100)
    assert.equal(second.models.find(m => m.familyId === 'gemini-4-neon').totalTokens, first.models.find(m => m.familyId === 'gemini-4-neon').totalTokens)

    // Deleting a file never rewrites history: the ledger still holds its buckets.
    rmSync(join(f.accounts[0].appDir, 'conversations', 'b.db'))
    const third = f.store().query(f.accounts, { range: 'month', force: true })
    assert.ok(third.models.some(m => m.familyId === 'claude-opus-5-5'), 'last Saturday stays in the month view after cleanup')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('time ranges filter the ledger: today, this week, this month, and the rolling 30 days', () => {
  const f = fixture()
  try {
    const store = f.store()
    store.query(f.accounts, { range: 'week', force: true })

    const today = store.query(f.accounts, { range: 'today' })
    assert.equal(today.rangeLabel, '2026-11-26')
    assert.equal(today.totals.calls, 1)
    assert.equal(today.totals.totalTokens, 420)
    assert.equal(today.daily.length, 7, 'today still draws a 7-day strip ending today')
    assert.deepEqual(today.daily.map(d => d.inRange), [false, false, false, false, false, false, true])

    const month = store.query(f.accounts, { range: 'month' })
    assert.equal(month.rangeLabel, '11/1 – 11/26')
    assert.ok(month.models.some(m => m.familyId === 'claude-opus-5-5'), 'the month includes last Saturday')
    assert.equal(month.totals.totalTokens, ALL_WEEK.total + CLAUDE.total, 'October usage is outside the month')
    assert.equal(month.daily.length, 26)
    assert.equal(month.daily[0].day, '2026-11-01')
    assert.equal(month.daily[25].isToday, true)
    assert.equal(month.daily[20].totalTokens, CLAUDE.total)
    assert.ok(month.daily.slice(0, 20).every(d => d.totalTokens === 0))

    const rolling = store.query(f.accounts, { range: '30d' })
    assert.equal(rolling.rangeLabel, '10/28 – 11/26')
    assert.equal(rolling.daily.length, 30)
    assert.equal(rolling.totals.totalTokens, month.totals.totalTokens, 'October 20 is outside the rolling window too')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('account filters isolate one subscription, and the standalone CLI history is opt-in for the machine account', () => {
  const f = fixture()
  try {
    const store = f.store()
    const all = store.query(f.accounts, { range: 'week', force: true })
    const work = store.query(f.accounts, { range: 'week', accountId: 'acc-work' })
    assert.equal(work.accountId, 'acc-work')
    assert.equal(work.totals.calls, 1)
    assert.equal(work.totals.totalTokens, HYDROGEN_WORK.total)
    assert.deepEqual(work.models.map(m => m.familyId), ['gemini-4-hydrogen'])
    // Account summaries still describe every account so the switcher keeps its badges.
    assert.equal(work.accounts.length, 2)

    const main = store.query(f.accounts, { range: 'week', accountId: 'default' })
    assert.equal(main.totals.totalTokens, DEFAULT_WEEK.total)
    assert.ok(!main.models.some(m => m.totalTokens === HYDROGEN_WORK.total))

    const withCli = store.query(f.accounts, { range: 'week', includeStandaloneCli: true })
    assert.equal(withCli.includeStandaloneCli, true)
    assert.equal(withCli.totals.calls, all.totals.calls + CLI_NEON.calls)
    assert.equal(withCli.totals.totalTokens, all.totals.totalTokens + CLI_NEON.total)
    // Standalone usage is credited to the machine account.
    assert.equal(withCli.accounts.find(a => a.accountId === 'default').totalTokens, DEFAULT_WEEK.total + CLI_NEON.total)
    assert.equal(withCli.accounts.find(a => a.accountId === 'acc-work').totalTokens, HYDROGEN_WORK.total)
    assert.equal(withCli.models.find(m => m.familyId === 'gemini-4-neon').totalTokens, NEON.total + CLI_NEON.total)

    // An unknown account id falls back to every account instead of an empty lie.
    const bogus = store.query(f.accounts, { range: 'week', accountId: 'acc-missing' })
    assert.equal(bogus.accountId, 'all')
    assert.equal(bogus.totals.totalTokens, all.totals.totalTokens)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('variant grouping splits effort tiers while family grouping collapses them', () => {
  const f = fixture()
  try {
    const store = f.store()
    store.query(f.accounts, { range: 'week', force: true })
    const families = store.query(f.accounts, { range: 'week', accountId: 'default', groupBy: 'family' })
    const variants = store.query(f.accounts, { range: 'week', accountId: 'default', groupBy: 'variant' })
    assert.equal(families.groupBy, 'family')
    assert.equal(variants.groupBy, 'variant')
    assert.ok(families.models.every(m => !/\((XHigh|High|Medium|Low)\)$/.test(m.name)))
    assert.equal(families.totals.totalTokens, variants.totals.totalTokens)
    const xhigh = variants.models.find(m => m.name === 'Gemini 4 Neon (XHigh)')
    const high = variants.models.find(m => m.name === 'Gemini 4 Neon (High)')
    assert.ok(xhigh && high, 'XHigh and High are separate rows')
    assert.equal(xhigh.familyId, 'gemini-4-neon')
    assert.equal(xhigh.familyName, 'Gemini 4 Neon')
    assert.equal(xhigh.colorGroup, 'neon')
    assert.equal(xhigh.calls, 2)
    assert.equal(xhigh.totalTokens, 6900)
    assert.equal(high.calls, 1)
    assert.equal(high.totalTokens, 420)
    assert.equal(xhigh.totalTokens + high.totalTokens, families.models.find(m => m.familyId === 'gemini-4-neon').totalTokens)
    assert.equal(new Set(variants.models.map(m => m.key)).size, variants.models.length)
    assert.equal(variants.models.find(m => m.name === 'Orchestrator (Neon)'), undefined)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('model display aliases from the settings override family labels in every view', () => {
  const f = fixture()
  try {
    const store = f.store()
    const snap = store.query(f.accounts, { range: 'week', groupBy: 'family', force: true }, { 'gemini-4-neon': 'Neon (主力)' })
    const neon = snap.models.find(m => m.familyId === 'gemini-4-neon')
    assert.equal(neon.name, 'Neon (主力)')
    assert.equal(neon.familyName, 'Neon (主力)')
    assert.ok(snap.daily[0].segments.some(s => s.name === 'Neon (主力)'))
    const variants = store.query(f.accounts, { range: 'week', groupBy: 'variant' }, { 'gemini-4-neon': 'Neon (主力)' })
    assert.equal(variants.models.find(m => m.name === 'Gemini 4 Neon (XHigh)').familyName, 'Neon (主力)')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('corrupt, empty, and non-database files are skipped without throwing and never touch the source files', () => {
  const f = fixture()
  try {
    const dir = join(f.accounts[0].appDir, 'conversations')
    writeFileSync(join(dir, 'garbage.db'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x53, 0x51]))
    writeFileSync(join(dir, 'empty.db'), Buffer.alloc(0))
    writeFileSync(join(dir, 'no-steps.db'), Buffer.from('not a database at all, really'))
    const real = join(dir, 'a.db')
    const before = statSync(real)
    const snap = f.store().query(f.accounts, { range: 'week', force: true })
    assert.equal(snap.status, 'ok')
    assert.equal(snap.scannedFiles, 6, 'only the six readable databases enter the ledger')
    const after = statSync(real)
    assert.equal(before.mtimeMs, after.mtimeMs, 'source databases are opened read-only and never rewritten')
    assert.equal(before.size, after.size)
    assert.equal(readFileSync(join(dir, 'garbage.db')).length, 8)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('an account with no conversation directory and an empty ledger answer with zeros, not errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-usage-empty-'))
  try {
    const accounts = [{ accountId: 'default', label: 'This PC', system: true, appDir: join(root, 'none'), geminiDir: root, homeDir: root }]
    const snap = new UsageLedgerStore(join(root, 'ledger.json'), { now: () => NOW }).query(accounts, { range: 'week', force: true })
    assert.equal(snap.status, 'ok')
    assert.equal(snap.scannedFiles, 0)
    assert.equal(snap.hasStandaloneCli, false)
    assert.deepEqual([snap.totals.totalTokens, snap.totals.calls, snap.totals.estimatedUsd, snap.totals.cacheHitRate], [0, 0, 0, 0])
    assert.deepEqual(snap.models, [])
    assert.equal(snap.daily.length, 7)
    assert.equal(snap.accounts[0].share, 0)
    assert.ok(!existsSync(join(root, 'ledger.json')), 'nothing is written when nothing was scanned')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the ledger lists the standalone CLI as its own source and tolerates a corrupt ledger file', () => {
  const f = fixture()
  try {
    writeFileSync(f.ledgerPath, '{ this is not json')
    const snap = f.store().query(f.accounts, { range: 'week', force: true })
    assert.equal(snap.status, 'ok')
    assert.equal(snap.scannedFiles, 6)
    const persisted = JSON.parse(readFileSync(f.ledgerPath, 'utf8'))
    assert.ok(Object.keys(persisted.files).some(k => k.startsWith(`${STANDALONE_CLI_SOURCE_KEY}::`)))
    assert.ok(Object.keys(persisted.files).every(k => k.includes('::')), 'file keys are namespaced by source account')
    assert.ok(Object.keys(persisted.files).filter(k => k.startsWith('default::')).length === 4)
    assert.ok(Object.keys(persisted.files).filter(k => k.startsWith('acc-work::')).length === 1)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('usageStats RPC request validation rejects malformed filters and the descriptor is registered', () => {
  assert.equal(parseUsageStatsRequest(undefined), undefined)
  assert.equal(parseUsageStatsRequest(null), undefined)
  assert.deepEqual(parseUsageStatsRequest({}), {})
  assert.deepEqual(parseUsageStatsRequest({ accountId: ' acc-work ', range: 'month', groupBy: 'variant', includeStandaloneCli: true, force: true }), {
    accountId: 'acc-work', range: 'month', groupBy: 'variant', includeStandaloneCli: true, force: true,
  })
  assert.throws(() => parseUsageStatsRequest('week'), /usageStats request/)
  assert.throws(() => parseUsageStatsRequest([]), /usageStats request/)
  assert.throws(() => parseUsageStatsRequest({ accountId: '' }), /request\.accountId/)
  assert.throws(() => parseUsageStatsRequest({ accountId: 7 }), /request\.accountId/)
  assert.throws(() => parseUsageStatsRequest({ range: 'year' }), /request\.range/)
  assert.throws(() => parseUsageStatsRequest({ range: 7 }), /request\.range/)
  assert.throws(() => parseUsageStatsRequest({ groupBy: 'day' }), /request\.groupBy/)
  assert.throws(() => parseUsageStatsRequest({ includeStandaloneCli: 'yes' }), /request\.includeStandaloneCli/)
  assert.throws(() => parseUsageStatsRequest({ force: 1 }), /request\.force/)

  const descriptor = INVOCATIONS.find(i => i.method === 'usageStats')
  assert.ok(descriptor, 'usageStats is exposed over the remote service')
  assert.equal(descriptor.parameters.length, 1)
  assert.equal(descriptor.parameters[0].acceptsUndefined, true)
  assert.equal(descriptor.id, 'dsh-llm-antigravity-acp#antigravityAcp/usageStats')
})
