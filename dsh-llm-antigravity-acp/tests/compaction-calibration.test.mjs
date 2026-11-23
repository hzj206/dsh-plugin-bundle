// Contract and Cordis integration tests for real-usage-aware compaction calibration.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  MIN_REAL_TO_HEURISTIC_RATIO,
  PRUNE_CREDIT_MIN_RATIO,
  calibrateTokenMeterMeasurement,
  installRealUsageCompactionCalibrator,
  realUsageTotal,
  unwrapCordisService,
} from '../lib/compaction-calibration.js'
import { Config, current } from '../lib/config.js'
import { AntigravityRuntime } from '../lib/runtime.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeSession({
  provider = 'antigravity',
  model = 'gemini-4-neon',
  tools = [{ name: 'read' }],
  events = [],
} = {}) {
  const header = { config: { provider, model, reasoningEffort: 'high' }, tools }
  return {
    get seq() { return events.length },
    eventAt(seq) { return events[seq] },
    requestHeader() { return header },
  }
}

function makeAssistantEvent(seq, opts = {}) {
  const provider = opts.provider ?? 'antigravity'
  const model = opts.model ?? 'gemini-4-neon'
  const usage = Object.hasOwn(opts, 'usage')
    ? opts.usage
    : { inputTokens: 3972, cacheReadTokens: 420047, outputTokens: 39102, reasoningTokens: 12275 }
  return {
    type: 'assistant/message',
    seq,
    data: {
      ...(usage !== undefined ? { usage } : {}),
      message: {
        role: 'assistant',
        source: { kind: 'model', provider, model },
      },
    },
  }
}

function makeRaw({
  baseline = { kind: 'estimated', tokens: 840_102 },
  surfaceDeltaTokens = 2_000,
  surfaceTokens = 814_102,
  nodes = [
    { seq: 0, tokens: 12_000, heuristicTokens: 12_000 },
    { seq: 1, tokens: 800_102, heuristicTokens: 800_102 },
    { seq: 2, tokens: 2_000, heuristicTokens: 2_000 },
  ],
  logRevision = 3,
} = {}) {
  return Object.freeze({
    logRevision,
    baseline: Object.freeze(baseline),
    surfaceDeltaTokens,
    totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
    surfaceTokens,
    nodes: Object.freeze(nodes.map(n => Object.freeze({ ...n }))),
  })
}

test('realUsageTotal matches dsh-token-meter formula and rejects invalid payloads', () => {
  // Real session-6335de7c Turn 30 Step 11 usage: must NOT double-count reasoningTokens (12275).
  assert.equal(realUsageTotal({
    inputTokens: 3972,
    cacheReadTokens: 420047,
    outputTokens: 39102,
    reasoningTokens: 12275,
  }), 463_121)
  assert.equal(realUsageTotal({
    inputTokens: 1000,
    cacheReadTokens: 2000,
    cacheWriteTokens: 500,
    outputTokens: 250,
  }), 3750)
  assert.equal(realUsageTotal(null), 0)
  assert.equal(realUsageTotal(undefined), 0)
  assert.equal(realUsageTotal({ inputTokens: -1, outputTokens: 10 }), 0)
  assert.equal(realUsageTotal({ inputTokens: Number.NaN, outputTokens: 10 }), 0)
  assert.equal(realUsageTotal({ inputTokens: 10, outputTokens: 10, cacheReadTokens: -5 }), 0)
})

test('replays session-6335de7c: avoids premature 44% compaction and triggers accurately at true 80%', () => {
  const threshold = Math.floor(1_048_576 * 0.8) // 838,860
  const events = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1, {
      usage: { inputTokens: 3972, cacheReadTokens: 420047, outputTokens: 39102, reasoningTokens: 12275 },
    }),
    { type: 'tool/result', seq: 2 },
  ]
  const session = makeSession({ events })
  const header = session.requestHeader()
  const raw = makeRaw()

  // Uncalibrated DSH heuristic is 842,102 >= 838,860 (premature compaction at 44% real usage).
  assert.ok(raw.totalTokens >= threshold)

  const calibrated = calibrateTokenMeterMeasurement(raw, session, header, {
    provider: 'antigravity',
    enabled: () => true,
  })
  assert.equal(calibrated.baseline.kind, 'usage')
  assert.equal(calibrated.baseline.tokens, 463_121)
  assert.equal(calibrated.surfaceDeltaTokens, 2_000)
  assert.equal(calibrated.totalTokens, 465_121)
  assert.ok(calibrated.totalTokens < threshold, '44% real occupancy must stay well below 80% compaction threshold')
  assert.equal(calibrated.nodes, raw.nodes, 'raw.nodes reference must stay identical for compaction-basic stability')
  assert.equal(calibrated.surfaceTokens, raw.surfaceTokens)
  assert.equal(Object.isFrozen(calibrated), true)
  assert.equal(Object.isFrozen(calibrated.baseline), true)

  // Later in the same session when true Gemini usage reaches 830K + 12K new tool result => 842K >= 838,860.
  const eventsAt80 = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1, {
      usage: { inputTokens: 8_000, cacheReadTokens: 810_000, outputTokens: 12_000, reasoningTokens: 4_000 },
    }),
    { type: 'tool/result', seq: 2 },
  ]
  const sessionAt80 = makeSession({ events: eventsAt80 })
  const rawAt80 = makeRaw({
    baseline: { kind: 'estimated', tokens: 1_450_000 },
    surfaceDeltaTokens: 12_000,
    surfaceTokens: 1_420_000,
    nodes: [
      { seq: 0, tokens: 10_000, heuristicTokens: 10_000 },
      { seq: 1, tokens: 1_398_000, heuristicTokens: 1_398_000 },
      { seq: 2, tokens: 12_000, heuristicTokens: 12_000 },
    ],
  })
  const calibratedAt80 = calibrateTokenMeterMeasurement(rawAt80, sessionAt80, header, {
    provider: 'antigravity',
    enabled: () => true,
  })
  assert.equal(calibratedAt80.totalTokens, 842_000)
  assert.ok(calibratedAt80.totalTokens >= threshold, 'true 80% real occupancy triggers compaction cleanly')
})

test('scales negative surfaceDeltaTokens conservatively after tool-result pruning', () => {
  const events = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1, {
      usage: { inputTokens: 10_000, cacheReadTokens: 820_000, outputTokens: 10_000 },
    }),
    { type: 'compaction/prune', seq: 2 },
    { type: 'tool/result', seq: 3 },
  ]
  const session = makeSession({ events })
  // ratio = 840_000 / 1_400_000 = 0.60 => -200_000 * 0.60 = -120_000 => 720_000.
  const raw = makeRaw({
    baseline: { kind: 'estimated', tokens: 1_400_000 },
    surfaceDeltaTokens: -200_000,
    surfaceTokens: 1_180_000,
    nodes: [
      { seq: 0, tokens: 10_000, heuristicTokens: 10_000 },
      { seq: 1, tokens: 1_168_000, heuristicTokens: 1_168_000 },
      { seq: 3, tokens: 2_000, heuristicTokens: 2_000 },
    ],
    logRevision: 4,
  })
  const calibrated = calibrateTokenMeterMeasurement(raw, session, session.requestHeader(), {
    provider: 'antigravity',
    enabled: () => true,
  })
  assert.equal(calibrated.surfaceDeltaTokens, -120_000)
  assert.equal(calibrated.totalTokens, 720_000)

  // When observed ratio (0.28) is below PRUNE_CREDIT_MIN_RATIO (0.35), clamp to 0.35.
  const eventsLowRatio = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1, {
      usage: { inputTokens: 10_000, cacheReadTokens: 260_000, outputTokens: 10_000 },
    }),
  ]
  const sessionLow = makeSession({ events: eventsLowRatio })
  const rawLow = makeRaw({
    baseline: { kind: 'estimated', tokens: 1_000_000 },
    surfaceDeltaTokens: -100_000,
    surfaceTokens: 880_000,
    nodes: [
      { seq: 0, tokens: 10_000, heuristicTokens: 10_000 },
      { seq: 1, tokens: 870_000, heuristicTokens: 870_000 },
    ],
    logRevision: 2,
  })
  const calibratedLow = calibrateTokenMeterMeasurement(rawLow, sessionLow, sessionLow.requestHeader(), {
    provider: 'antigravity',
    enabled: () => true,
  })
  assert.equal(calibratedLow.surfaceDeltaTokens, Math.round(-100_000 * PRUNE_CREDIT_MIN_RATIO))
  assert.equal(calibratedLow.totalTokens, 280_000 - Math.round(100_000 * PRUNE_CREDIT_MIN_RATIO))
})

test('post-compaction convergence guard: returns raw untouched after compaction/summary, resumes after next assistant turn', () => {
  const eventsAfterCompact = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1, {
      usage: { inputTokens: 10_000, cacheReadTokens: 830_000, outputTokens: 10_000 },
    }),
    { type: 'compaction/summary', seq: 2 },
  ]
  const sessionAfterCompact = makeSession({ events: eventsAfterCompact })
  const rawAfterCompact = makeRaw({
    baseline: { kind: 'estimated', tokens: 1_400_000 },
    surfaceDeltaTokens: -1_220_000,
    surfaceTokens: 180_000,
    nodes: [
      { seq: 2, tokens: 30_000, heuristicTokens: 30_000 },
      { seq: 1, tokens: 150_000, heuristicTokens: 150_000 },
    ],
    logRevision: 3,
  })
  const afterCompact = calibrateTokenMeterMeasurement(rawAfterCompact, sessionAfterCompact, sessionAfterCompact.requestHeader(), {
    provider: 'antigravity',
    enabled: () => true,
  })
  assert.equal(afterCompact, rawAfterCompact, 'must return raw untouched right after compaction/summary')
  assert.equal(afterCompact.totalTokens, 180_000)

  // Next turn lands a fresh assistant/message after seq 2 -> calibration resumes automatically.
  const eventsNextTurn = [
    ...eventsAfterCompact,
    { type: 'user/message', seq: 3 },
    makeAssistantEvent(4, {
      usage: { inputTokens: 2_000, cacheReadTokens: 118_000, outputTokens: 5_000 },
    }),
    { type: 'tool/result', seq: 5 },
  ]
  const sessionNext = makeSession({ events: eventsNextTurn })
  const rawNext = makeRaw({
    baseline: { kind: 'estimated', tokens: 220_000 },
    surfaceDeltaTokens: 3_000,
    surfaceTokens: 203_000,
    nodes: [
      { seq: 2, tokens: 30_000, heuristicTokens: 30_000 },
      { seq: 3, tokens: 10_000, heuristicTokens: 10_000 },
      { seq: 4, tokens: 160_000, heuristicTokens: 160_000 },
      { seq: 5, tokens: 3_000, heuristicTokens: 3_000 },
    ],
    logRevision: 6,
  })
  const resumed = calibrateTokenMeterMeasurement(rawNext, sessionNext, sessionNext.requestHeader(), {
    provider: 'antigravity',
    enabled: () => true,
  })
  assert.equal(resumed.baseline.kind, 'usage')
  assert.equal(resumed.totalTokens, 128_000)
})

test('safety guards: provider switch, model switch, image-heavy usage baseline, truncation anomaly, and missing usage', () => {
  const baseEvents = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1),
    { type: 'tool/result', seq: 2 },
  ]
  const session = makeSession({ events: baseEvents })
  const raw = makeRaw()

  // 1. Disabled toggle.
  assert.equal(
    calibrateTokenMeterMeasurement(raw, session, session.requestHeader(), { provider: 'antigravity', enabled: () => false }),
    raw,
  )

  // 2. Non-Antigravity provider.
  const otherSession = makeSession({ provider: 'xfkj', model: 'deepseek-reasoner', events: baseEvents })
  assert.equal(
    calibrateTokenMeterMeasurement(raw, otherSession, otherSession.requestHeader(), { provider: 'antigravity', enabled: () => true }),
    raw,
  )

  // 3. Pre-flight model switch (e.g. 1M gemini-4-neon -> 128K gpt-oss-120b-medium).
  const switchedHeader = { config: { provider: 'antigravity', model: 'gpt-oss-120b-medium' }, tools: [] }
  assert.equal(
    calibrateTokenMeterMeasurement(raw, session, switchedHeader, { provider: 'antigravity', enabled: () => true }),
    raw,
  )

  // 4. Post-header model switch before new model replies (anchor source still gemini-4-neon).
  const postSwitchSession = makeSession({ provider: 'antigravity', model: 'gpt-oss-120b-medium', events: baseEvents })
  assert.equal(
    calibrateTokenMeterMeasurement(raw, postSwitchSession, postSwitchSession.requestHeader(), { provider: 'antigravity', enabled: () => true }),
    raw,
  )

  // 5. Image-heavy session where dsh-token-meter already picked baseline.kind === 'usage'.
  const rawImageHeavy = makeRaw({
    baseline: { kind: 'usage', tokens: 910_000, usage: { inputTokens: 900_000, outputTokens: 10_000 } },
    surfaceDeltaTokens: 0,
  })
  assert.equal(
    calibrateTokenMeterMeasurement(rawImageHeavy, session, session.requestHeader(), { provider: 'antigravity', enabled: () => true }),
    rawImageHeavy,
  )

  // 6. 128K silent truncation anomaly (usage / estimatedAnchor = 128K / 840K = 0.152 < 0.25).
  const truncatedEvents = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1, { usage: { inputTokens: 120_000, outputTokens: 8_000 } }),
    { type: 'tool/result', seq: 2 },
  ]
  const truncatedSession = makeSession({ events: truncatedEvents })
  assert.ok(128_000 / 840_102 < MIN_REAL_TO_HEURISTIC_RATIO)
  assert.equal(
    calibrateTokenMeterMeasurement(raw, truncatedSession, truncatedSession.requestHeader(), { provider: 'antigravity', enabled: () => true }),
    raw,
  )

  // 7. Latest assistant/message lacks usage: must NOT fall back to an older assistant/message!
  const unbilledEvents = [
    makeAssistantEvent(0, { usage: { inputTokens: 10_000, cacheReadTokens: 400_000, outputTokens: 5_000 } }),
    makeAssistantEvent(1, { usage: undefined }),
    { type: 'tool/result', seq: 2 },
  ]
  const unbilledSession = makeSession({ events: unbilledEvents })
  assert.equal(
    calibrateTokenMeterMeasurement(raw, unbilledSession, unbilledSession.requestHeader(), { provider: 'antigravity', enabled: () => true }),
    raw,
  )

  // 8. Newer off-surface empty assistant/message after anchor seq.
  const newerEmptyAssistant = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1),
    { type: 'tool/result', seq: 2 },
    makeAssistantEvent(3, { usage: undefined }),
  ]
  const newerSession = makeSession({ events: newerEmptyAssistant })
  const rawWithNewer = makeRaw({ logRevision: 4 })
  assert.equal(
    calibrateTokenMeterMeasurement(rawWithNewer, newerSession, newerSession.requestHeader(), { provider: 'antigravity', enabled: () => true }),
    rawWithNewer,
  )
})

test('same-model header reprice (effort change or tool schema growth) preserves post-anchor tokens', () => {
  const events = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1, { usage: { inputTokens: 4_000, cacheReadTokens: 420_000, outputTokens: 36_000 } }),
    { type: 'user/message', seq: 2 },
  ]
  const session = makeSession({ events, tools: [{ name: 'read', description: 'a' }] })
  // Simulate dsh-token-meter's header-mismatch else branch: surfaceDeltaTokens === 0, baseline includes postAnchorTokens.
  const rawRepriced = makeRaw({
    baseline: { kind: 'estimated', tokens: 850_000 },
    surfaceDeltaTokens: 0,
    surfaceTokens: 830_000,
    nodes: [
      { seq: 0, tokens: 10_000, heuristicTokens: 10_000 },
      { seq: 1, tokens: 810_000, heuristicTokens: 810_000 },
      { seq: 2, tokens: 10_000, heuristicTokens: 10_000 },
    ],
  })
  const biggerToolsHeader = {
    config: { provider: 'antigravity', model: 'gemini-4-neon', reasoningEffort: 'xhigh' },
    tools: [{ name: 'read', description: 'a' }, { name: 'extra', description: 'x'.repeat(4_000) }],
  }
  const calibrated = calibrateTokenMeterMeasurement(rawRepriced, session, biggerToolsHeader, {
    provider: 'antigravity',
    enabled: () => true,
  })
  assert.equal(calibrated.baseline.kind, 'usage')
  assert.equal(calibrated.baseline.tokens, 460_000)
  // postAnchorTokens (10_000) + tool growth (~1000+ tokens)
  assert.ok(calibrated.surfaceDeltaTokens > 10_500 && calibrated.surfaceDeltaTokens < 12_000)
  assert.equal(calibrated.totalTokens, 460_000 + calibrated.surfaceDeltaTokens)
})

test('Config schema defaults realUsageCompaction to true and accepts false', () => {
  assert.equal(current(Config({}).realUsageCompaction), true)
  assert.equal(current(Config({ realUsageCompaction: false }).realUsageCompaction), false)
})

test('Cordis Service integration: unwraps traceable proxy, intercepts sibling plugins, respects live toggle, and restores cleanly on dispose', async () => {
  class FakeTokenMeter extends Service {
    calls = 0
    seenCtxNames = []
    constructor(ctx) {
      super(ctx, 'tokenMeter')
    }
    measure(_session, _requestHeader) {
      this.calls += 1
      this.seenCtxNames.push(Boolean(this.ctx))
      return makeRaw()
    }
  }

  const root = new Context()
  root.plugin(FakeTokenMeter)

  let enabled = true
  const pluginFork = root.plugin((ctx) => {
    ctx.inject(['tokenMeter'], (meterCtx) => {
      const meter = meterCtx.get('tokenMeter')
      assert.notEqual(unwrapCordisService(meter), meter, 'Cordis injects a traceable proxy around Service instances')
      meterCtx.effect(() => installRealUsageCompactionCalibrator(meter, {
        provider: 'antigravity',
        enabled: () => enabled,
      }), 'test: compaction calibrator')
    })
  })

  // Sibling consumer (mirrors dsh-compaction-basic accessing this.ctx.tokenMeter.measure).
  let siblingMeter
  root.plugin((ctx) => {
    ctx.inject(['tokenMeter'], (c) => { siblingMeter = c.tokenMeter })
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(siblingMeter, 'sibling plugin received tokenMeter proxy')

  const events = [
    { type: 'user/message', seq: 0 },
    makeAssistantEvent(1),
    { type: 'tool/result', seq: 2 },
  ]
  const session = makeSession({ events })
  const header = session.requestHeader()

  // 1. Intercepted across sibling Cordis proxy!
  const first = siblingMeter.measure(session, header)
  assert.equal(first.baseline.kind, 'usage')
  assert.equal(first.totalTokens, 465_121)

  // 2. Live toggle off returns raw immediately without unloading.
  enabled = false
  const second = siblingMeter.measure(session, header)
  assert.equal(second.baseline.kind, 'estimated')
  assert.equal(second.totalTokens, 842_102)

  // 3. Live toggle back on calibrates again.
  enabled = true
  const third = siblingMeter.measure(session, header)
  assert.equal(third.totalTokens, 465_121)

  // 4. Disposing our plugin restores the underlying TokenMeter cleanly.
  await pluginFork.dispose()
  const rawInstance = unwrapCordisService(siblingMeter)
  assert.equal(Object.getOwnPropertyDescriptor(rawInstance, 'measure'), undefined, 'own measure override is cleanly removed')
  const fourth = siblingMeter.measure(session, header)
  assert.equal(fourth.baseline.kind, 'estimated')
  assert.equal(fourth.totalTokens, 842_102)
  assert.equal(rawInstance.calls, 4)
  assert.deepEqual(rawInstance.seenCtxNames, [true, true, true, true])

  await root.fiber.dispose()
})

test('AntigravityRuntime exposes live realUsageCompaction toggle via volatile config and configure()', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-compaction-runtime-'))
  let volatileFlag = true
  const runtime = new AntigravityRuntime({
    config: {
      ...Config({ home: dir, warmup: false }),
      realUsageCompaction: { get: () => volatileFlag },
    },
    spawnAcp: () => { throw new Error('unused') },
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    readImage: async () => undefined,
    canReadImages: () => false,
    log: { info: () => {}, warn: () => {} },
    onModelsChanged: () => {},
  })
  try {
    assert.equal(runtime.realUsageCompaction(), true)
    assert.equal(runtime.status().realUsageCompaction, true)

    volatileFlag = false
    assert.equal(runtime.realUsageCompaction(), false)
    assert.equal(runtime.status().realUsageCompaction, false)

    volatileFlag = true
    assert.equal(runtime.realUsageCompaction(), true)

    const updated = runtime.configure({ realUsageCompaction: false })
    assert.equal(updated.realUsageCompaction, false)
    assert.equal(runtime.realUsageCompaction(), false)

    const reenabled = runtime.configure({ realUsageCompaction: true })
    assert.equal(reenabled.realUsageCompaction, true)
    assert.equal(runtime.realUsageCompaction(), true)
  } finally {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
