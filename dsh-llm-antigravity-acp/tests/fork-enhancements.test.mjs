// Regression tests for fork baseline enhancements: xhigh reasoning effort,
// Gemini 4 Neon / Hydrogen / Orchestrator model labels, and gpt-oss context cap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityAdapter } from '../lib/adapter.js'
import { EFFORT_NAMES, ModelCatalog, nearestEffort } from '../lib/catalog.js'
import { deriveAccountModels } from '../lib/cloudcode.js'
import { EFFORTS } from '../lib/config.js'
import { AntigravityRuntime } from '../lib/runtime.js'

test('EFFORTS and EFFORT_NAMES include xhigh and nearestEffort resolves it cleanly', () => {
  assert.deepEqual([...EFFORTS], ['low', 'medium', 'high', 'xhigh'])
  assert.equal(EFFORT_NAMES.xhigh, 'XHigh')
  assert.equal(nearestEffort('xhigh', ['low', 'medium', 'high', 'xhigh']), 'xhigh')
  assert.equal(nearestEffort('xhigh', ['low', 'medium', 'high']), 'high')
})

test('deriveAccountModels parses xhigh variants and Neon/Hydrogen/Orchestrator display names', () => {
  const derived = deriveAccountModels({
    agentModelSorts: [{
      groups: [{
        modelIds: [
          'gemini-4-neon-xhigh',
          'gemini-4-neon-high',
          'gemini-4-neon-medium',
          'gemini-4-neon-low',
          'gemini-4-hydrogen-xhigh',
          'gemini-4-hydrogen-high',
          'gemini-4-argon-high',
          'gemini-4-argon-medium',
          'gemini-pro-orchestrator-neon',
          'gemini-pro-orchestrator-g1-pro',
        ],
      }],
    }],
    models: {
      'gemini-4-neon-xhigh': { displayName: 'Gemini 4 Neon (XHigh)', maxTokens: 1048576 },
      'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)', maxTokens: 1048576 },
      'gemini-4-neon-medium': { displayName: 'Gemini 4 Neon (Medium)', maxTokens: 1048576 },
      'gemini-4-neon-low': { displayName: 'Gemini 4 Neon (Low)', maxTokens: 1048576 },
      'gemini-4-hydrogen-xhigh': { displayName: 'Gemini 4 Hydrogen (XHigh)', maxTokens: 1048576 },
      'gemini-4-hydrogen-high': { displayName: 'Gemini 4 Hydrogen (High)', maxTokens: 1048576 },
      'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', maxTokens: 1048576 },
      'gemini-4-argon-medium': { displayName: 'Gemini 4 Argon (Medium)', maxTokens: 1048576 },
      'gemini-pro-orchestrator-neon': { maxTokens: 1048576 },
      'gemini-pro-orchestrator-g1-pro': { maxTokens: 1048576 },
    },
  }, [
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'g-w', window: 'weekly', remainingFraction: 1 }] },
    { displayName: 'Gemini 4 Argon', buckets: [{ bucketId: 'a-w', window: 'weekly', remainingFraction: 1 }] },
  ], 'PRO')

  assert.deepEqual(derived.effortsByModel['gemini-4-neon'], ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(derived.effortsByModel['gemini-4-hydrogen'], ['high', 'xhigh'])
  assert.deepEqual(derived.effortsByModel['gemini-4-argon'], ['medium', 'high'])
  assert.equal(derived.models.find(m => m.id === 'gemini-4-neon')?.name, 'Gemini 4 Neon')
  assert.equal(derived.models.find(m => m.id === 'gemini-4-hydrogen')?.name, 'Gemini 4 Hydrogen')
  assert.equal(derived.models.find(m => m.id === 'gemini-pro-orchestrator-neon')?.name, 'Orchestrator (Neon)')
  assert.equal(derived.models.find(m => m.id === 'gemini-pro-orchestrator-g1-pro')?.name, 'Orchestrator (Argon)')
})

test('observeSlotCatalog keeps xhigh efforts through union catalog and adapter.resolveModel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-xhigh-'))
  const catalog = new ModelCatalog(join(dir, 'catalog.json'))
  const slot = {
    layout: { id: 'default', enabled: true },
    availableModels: undefined,
    effortsByModel: undefined,
    maxTokensByModel: undefined,
  }
  const fakeRuntime = {
    catalog,
    slots: new Map([['default', slot]]),
    host: { onModelsChanged: () => {} },
    providerVisible: () => [],
    defaultEffort: () => 'high',
    contextWindowFor: () => 1048576,
    recomputeUnionCatalog: AntigravityRuntime.prototype.recomputeUnionCatalog,
    observeSlotCatalog: AntigravityRuntime.prototype.observeSlotCatalog,
  }

  fakeRuntime.observeSlotCatalog(slot, [
    {
      id: 'model',
      category: 'model',
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
        { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
      ],
    },
    {
      id: 'thought_level',
      category: 'thought_level',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'XHigh' },
      ],
    },
  ], [
    { modelId: 'gemini-4-neon-low' },
    { modelId: 'gemini-4-neon-medium' },
    { modelId: 'gemini-4-neon-high' },
    { modelId: 'gemini-4-neon-xhigh' },
    { modelId: 'gemini-4-argon-low' },
    { modelId: 'gemini-4-argon-medium' },
    { modelId: 'gemini-4-argon-high' },
    { modelId: 'gpt-oss-120b-medium' },
  ])

  const adapter = new AntigravityAdapter(fakeRuntime, 'Antigravity', () => true)
  const neon = await adapter.resolveModel('antigravity', 'gemini-4-neon')
  const argon = await adapter.resolveModel('antigravity', 'gemini-4-argon')
  const gptOss = await adapter.resolveModel('antigravity', 'gpt-oss-120b-medium')

  assert.deepEqual(neon.reasoning?.efforts.map(e => e.id), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(argon.reasoning?.efforts.map(e => e.id), ['low', 'medium', 'high'])
  assert.equal(gptOss.reasoning, undefined)
})

test('global configured contextWindow caps gpt-oss at 128K while preserving larger windows for Gemini', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-ctx-'))
  const runtime = new AntigravityRuntime({
    config: {
      provider: 'antigravity',
      displayName: 'Antigravity',
      command: 'agy',
      home,
      accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
      contextWindow: 512_000,
      defaultEffort: 'high',
      autoPatch: false,
      patchScript: join(home, 'missing.py'),
      maxLiveSessions: 4,
      idleSessionTtlMs: 60_000,
      parkSettleMs: 50,
      keepAliveMs: 1_000,
      longDecodeContinuations: 3,
      warmup: false,
      quotaTtlMs: 60_000,
    },
    spawnAcp: () => { throw new Error('unused') },
    runCommand: async () => ({ code: 0, stdout: '{}', stderr: '' }),
    readImage: async () => ({ data: '', mimeType: 'image/png' }),
    canReadImages: () => true,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  assert.equal(runtime.contextWindowFor('gpt-oss-120b-medium'), 131_072)
  assert.equal(runtime.contextWindowFor('gemini-4-neon'), 512_000)
  return runtime.dispose()
})
