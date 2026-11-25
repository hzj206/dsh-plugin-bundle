// UI tests for QuotaPill, Popover dialog, and SettingsCard in src/client.js / lib/client.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const srcClientPath = join(root, 'src', 'client.js')
const libClientPath = join(root, 'lib', 'client.js')

const FIXED_NOW = Date.parse('2026-11-04T12:00:00.000Z')
const isoAfterHours = (hours) => new Date(FIXED_NOW + hours * 3_600_000).toISOString()

function createMiniReact() {
  let active = null

  const flatten = (items, out = []) => {
    for (const item of items) {
      if (Array.isArray(item)) flatten(item, out)
      else if (item !== null && item !== undefined && typeof item !== 'boolean') out.push(item)
    }
    return out
  }

  const depsEqual = (a, b) => {
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!Object.is(a[i], b[i])) return false
    }
    return true
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = flatten(children)
      const nextProps = { ...(props || {}) }
      if (flat.length > 0) nextProps.children = flat
      return { __vnode: true, type, props: nextProps, ref: props ? props.ref : undefined }
    },
    useState(initial) {
      const inst = active
      const idx = inst.hookIndex++
      if (!(idx in inst.hooks)) {
        inst.hooks[idx] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = inst.hooks[idx]
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(value, slot.value)) {
          slot.value = value
          inst.root.render()
        }
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      const inst = active
      const idx = inst.hookIndex++
      if (!(idx in inst.hooks)) inst.hooks[idx] = { current: initial }
      return inst.hooks[idx]
    },
    useCallback(fn, deps) {
      const inst = active
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (!prev || !depsEqual(prev.deps, deps)) inst.hooks[idx] = { fn, deps }
      return inst.hooks[idx].fn
    },
    useEffect(fn, deps) {
      const inst = active
      const idx = inst.hookIndex++
      const prev = inst.hooks[idx]
      if (!prev || !depsEqual(prev.deps, deps)) {
        const slot = { deps, cleanup: prev ? prev.cleanup : undefined }
        inst.hooks[idx] = slot
        inst.root.pendingEffects.push(() => {
          if (typeof slot.cleanup === 'function') slot.cleanup()
          slot.cleanup = fn()
        })
      }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      React.useEffect(() => subscribe(() => activeRootRender()), [subscribe])
      const inst = active
      const activeRootRender = () => inst.root.render()
      return getSnapshot()
    },
  }

  function mount(Component, initialProps) {
    const root = {
      props: initialProps,
      instances: new Map(),
      pendingEffects: [],
      tree: null,
      render() {
        const seen = new Set()
        const renderVNode = (vnode, path) => {
          if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null
          if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode)
          if (!vnode.__vnode) return null

          if (typeof vnode.type === 'function') {
            seen.add(path)
            let inst = root.instances.get(path)
            if (!inst) {
              inst = { hooks: [], hookIndex: 0, root }
              root.instances.set(path, inst)
            }
            const prev = active
            active = inst
            inst.hookIndex = 0
            const rendered = vnode.type(vnode.props)
            active = prev
            return renderVNode(rendered, `${path}>f`)
          }

          const children = (vnode.props.children || [])
            .map((child, i) => renderVNode(child, `${path}/${i}`))
            .filter((child) => child !== null)
          const host = { tag: vnode.type, props: vnode.props, children }
          if (vnode.ref && typeof vnode.ref === 'object') {
            vnode.ref.current = {
              node: host,
              contains: (target) => Boolean(target && target.__insideRoot === vnode.ref),
            }
          }
          return host
        }

        root.tree = renderVNode(React.createElement(Component, root.props), 'root')
        for (const [key, inst] of root.instances.entries()) {
          if (!seen.has(key)) {
            for (const h of inst.hooks) {
              if (h && typeof h.cleanup === 'function') h.cleanup()
            }
            root.instances.delete(key)
          }
        }
        while (root.pendingEffects.length > 0) {
          const batch = root.pendingEffects.splice(0)
          for (const run of batch) run()
        }
        return root.tree
      },
      rerender(nextProps) {
        root.props = nextProps
        return root.render()
      },
      unmount() {
        for (const inst of root.instances.values()) {
          for (const h of inst.hooks) {
            if (h && typeof h.cleanup === 'function') h.cleanup()
          }
        }
        root.instances.clear()
        root.tree = null
      },
    }
    root.render()
    return root
  }

  return { React, mount }
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  return (node.children || []).map(textOf).join('')
}

function findAll(node, predicate, acc = []) {
  if (!node || typeof node === 'string') return acc
  if (predicate(node)) acc.push(node)
  for (const child of node.children || []) findAll(child, predicate, acc)
  return acc
}

function findOne(node, predicate) {
  return findAll(node, predicate)[0] || null
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function loadClientPlugin({ language = 'zh-CN', remoteService, sessions, uiWorkspace, clipboard, now } = {}) {
  const { React, mount } = createMiniReact()
  const listeners = new Map()
  const document = {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn)
    },
    dispatch(type, event) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event)
    },
  }

  let loadedSpec = null
  const winListeners = new Map()
  const window = {
    __ModuleLoader__: {
      load(spec) {
        loadedSpec = spec
      },
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set())
      winListeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn)
    },
    dispatch(type, event) {
      for (const fn of [...(winListeners.get(type) || [])]) fn(event)
    },
  }

  const clock = typeof now === 'function' ? now : () => FIXED_NOW
  class CustomDate extends Date {
    static now() {
      return clock()
    }
  }

  const intervals = new Set()
  const sandbox = {
    window,
    document,
    navigator: { language, ...(clipboard === undefined ? {} : { clipboard }) },
    Date: CustomDate,
    console,
    TypeError,
    Error,
    Promise,
    Object,
    Array,
    Number,
    String,
    Math,
    RegExp,
    setTimeout,
    clearTimeout,
    setInterval(fn) {
      const token = { fn }
      intervals.add(token)
      return token
    },
    clearInterval(token) {
      intervals.delete(token)
    },
  }

  const code = readFileSync(libClientPath, 'utf8')
  vm.runInNewContext(code, sandbox, { filename: libClientPath })
  assert.ok(loadedSpec, 'window.__ModuleLoader__.load should receive module spec')
  assert.equal(loadedSpec.id, 'dsh-llm-antigravity-acp')

  const plugin = loadedSpec.factory((pkg) => {
    if (pkg === 'react') return React
    if (pkg === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Modal(props) {
          if (props.open !== true) return null
          const footer = props.footer ? (Array.isArray(props.footer) ? props.footer : [props.footer]) : []
          return React.createElement('div', { 'aria-label': props.title, role: 'dialog' }, props.children, ...footer)
        },
        Button(props) {
          return React.createElement('button', {
            type: 'button',
            disabled: props.disabled,
            onClick: props.onClick,
            title: props.title,
          }, props.children)
        },
        // The real primitive clones its anchor and portals a bubble; the
        // settings tests only need the label to travel with the anchor.
        Tooltip(props) {
          return React.createElement('span', { 'data-tooltip': props.label }, props.children)
        },
      }
    }
    throw new Error(`Unexpected require(${pkg})`)
  })

  const registered = new Map()
  let currentModel = { provider: 'antigravity', model: 'gemini-4-argon' }
  const storeSubscribers = new Set()
  const store = {
    getSnapshot: () => ({ current: currentModel }),
    subscribe: (cb) => {
      storeSubscribers.add(cb)
      return () => storeSubscribers.delete(cb)
    },
    setCurrent(next) {
      currentModel = next
      for (const cb of [...storeSubscribers]) cb()
    },
  }

  const defaultService = {
    status: async () => ({
      state: 'ready',
      version: '1.2.3',
      contextWindow: 1_048_576,
      configuredContextWindow: 0,
      defaultEffort: 'high',
      longDecodeContinuations: 3,
      unlock: { status: 'unlocked' },
    }),
    quota: async () => ({ status: 'ok', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [] }),
    warmup: async () => ({ state: 'ready', version: '1.2.3', contextWindow: 1_048_576 }),
    configure: async (patch) => ({ state: 'ready', version: '1.2.3', contextWindow: 1_048_576, ...patch }),
    accounts: async () => [],
  }
  // Overrides merge over the defaults, so a test that only fakes one verb
  // still answers every other call the card makes.
  const service = { ...defaultService, ...(remoteService || {}) }

  const slots = {
    inject(_slotName, registerFn) {
      return registerFn()
    },
    register(meta, Component) {
      registered.set(meta.name, { meta, Component })
      return () => registered.delete(meta.name)
    },
  }

  const ctx = {
    remote: { $mount: () => () => undefined, session: { selectModel: async () => undefined } },
    slots,
    modelDirectories: { directoryFor: () => ({ store }) },
    sessions: sessions || {
      binding: () => undefined,
      list: { getSnapshot: () => ({ byId: {} }) },
      create: async () => 'child-session-default',
      fork: async () => 'child-session-forked',
      retain: () => ({ ready: Promise.resolve({ session: { beginSubmission: () => ({ requestId: 'r1', abandon: () => {} }), prompt: async () => ({ ok: true }) } }), release: () => {} }),
    },
    uiWorkspace: uiWorkspace || { openSession: () => {} },
    effect(fn) {
      fn()
    },
    get(key) {
      if (key === 'remote.antigravityAcp') return service
      return undefined
    },
    inject(_deps, cb) {
      cb(ctx)
    },
  }

  plugin.apply(ctx)
  return { registered, mount, document, store, intervals }
}

test('lib/client.js stays in sync with src/client.js and stays isolated in a multi-plugin combo script', () => {
  const modelSelectionPath = join(root, 'src', 'model-selection.js')
  const composed = existsSync(modelSelectionPath)
    ? `${readFileSync(modelSelectionPath, 'utf8')}\n${readFileSync(srcClientPath, 'utf8')}`
    : readFileSync(srcClientPath, 'utf8')
  const expected = `;(() => {\n${composed}\n})();\n`
  const bundle = readFileSync(libClientPath, 'utf8')
  assert.equal(bundle, expected)
  const loaded = []
  vm.runInNewContext(`${bundle}\n${bundle}`, { window: { __ModuleLoader__: { load(spec) { loaded.push(spec.id) } } } })
  assert.deepEqual(loaded, ['dsh-llm-antigravity-acp', 'dsh-llm-antigravity-acp'])
})

test('QuotaPill (zh-CN) prioritizes weekly bucket over preceding 5h bucket in collapsed pill and tooltip', async () => {
  let resolveQuota
  const quotaPromise = new Promise((resolve) => { resolveQuota = resolve })
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      quota: () => quotaPromise,
    },
  })

  const slot = registered.get('conversation.input.right')
  assert.ok(slot, 'QuotaPill should register on conversation.input.right')
  const props = slot.meta.inject('session-1')
  const view = mount(slot.Component, props)

  // Loading state before quota resolves
  const loadingBtn = findOne(view.tree, (n) => n.tag === 'button')
  assert.equal(textOf(loadingBtn), '周 …')
  assert.equal(loadingBtn.props.title, 'Antigravity 套餐额度')

  // Resolve with 5h (95%) intentionally placed BEFORE weekly (68%)
  resolveQuota({
    status: 'ok',
    updatedAt: new Date(FIXED_NOW).toISOString(),
    groups: [{
      name: 'Gemini Models',
      description: 'Gemini family',
      buckets: [
        { id: 'five_hour', name: '5-hour', window: '5h', remainingFraction: 0.95, resetTime: isoAfterHours(4) },
        { id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.68, resetTime: isoAfterHours(62) },
      ],
    }],
  })
  await flush()

  const btn = findOne(view.tree, (n) => n.tag === 'button')
  assert.equal(textOf(btn), '周 68%')
  assert.ok(!textOf(btn).includes('95%'), 'collapsed pill must not render 5h percentage')
  assert.equal(btn.props.title, 'Gemini 每周额度 68%（2天14小时后重置） · 5 小时 95%')

  // Check progress bar inside collapsed button reflects 68% and green threshold (#2e9e6a)
  const barTrack = findOne(btn, (n) => n.tag === 'span' && n.props['aria-hidden'] === 'true')
  assert.ok(barTrack)
  const barFill = barTrack.children[0]
  assert.equal(barFill.props.style.width, '68%')
  assert.equal(barFill.props.style.background, '#2e9e6a')

  view.unmount()
})

test('QuotaPill (en-US) matches weekly by id/name regex, renders Wk prefix, and orders weekly first in popover', async () => {
  const { registered, mount, document } = loadClientPlugin({
    language: 'en-US',
    remoteService: {
      quota: async () => ({
        status: 'ok',
        updatedAt: new Date(FIXED_NOW).toISOString(),
        groups: [{
          name: 'Gemini',
          description: '',
          buckets: [
            { id: 'short_window', name: '5h limit', window: '5h', remainingFraction: 0.95, resetTime: isoAfterHours(3) },
            { id: 'gemini_weekly_cap', name: 'Pro Limit', window: '', remainingFraction: 0.68, resetTime: isoAfterHours(62) },
          ],
        }],
      }),
    },
  })

  const slot = registered.get('conversation.input.right')
  const view = mount(slot.Component, slot.meta.inject('session-en'))
  await flush()

  const btn = findOne(view.tree, (n) => n.tag === 'button')
  assert.equal(textOf(btn), 'Wk 68%')
  assert.equal(btn.props.title, 'Gemini weekly quota 68% (resets in 2d 14h) · 5h 95%')
  assert.equal(btn.props['aria-expanded'], false)

  // Open popover dialog
  btn.props.onClick()
  await flush()

  const dialog = findOne(view.tree, (n) => n.props && n.props.role === 'dialog')
  assert.ok(dialog, 'clicking QuotaPill should open role="dialog" popover')
  assert.match(dialog.props.style.background, /var\(--dsw-alias-surface-overlay/)
  assert.match(dialog.props.style.border, /color-mix\(in srgb/)

  // Verify bucket order: weekly primary card first, 5h secondary row second
  const bucketNodes = findAll(dialog, (n) => n.props && 'data-bucket-role' in n.props)
  assert.equal(bucketNodes.length, 2)
  assert.equal(bucketNodes[0].props['data-bucket-role'], 'primary')
  assert.equal(bucketNodes[0].props['data-bucket-window'], 'gemini_weekly_cap')
  assert.match(textOf(bucketNodes[0]), /Weekly quota/)
  assert.match(textOf(bucketNodes[0]), /68%/)
  assert.match(textOf(bucketNodes[0]), /Resets in 2d 14h/)

  assert.equal(bucketNodes[1].props['data-bucket-role'], 'secondary')
  assert.equal(bucketNodes[1].props['data-bucket-window'], '5h')
  assert.match(textOf(bucketNodes[1]), /5h/)
  assert.match(textOf(bucketNodes[1]), /95%/)

  // Escape closes popover
  document.dispatch('keydown', { key: 'Escape' })
  assert.equal(findOne(view.tree, (n) => n.props && n.props.role === 'dialog'), null)

  // Reopen and close via outside pointerdown
  findOne(view.tree, (n) => n.tag === 'button').props.onClick()
  await flush()
  assert.ok(findOne(view.tree, (n) => n.props && n.props.role === 'dialog'))
  document.dispatch('pointerdown', { target: {} })
  assert.equal(findOne(view.tree, (n) => n.props && n.props.role === 'dialog'), null)

  view.unmount()
})

test('QuotaPill bar color thresholds, error state, non-weekly fallback, and provider visibility', async () => {
  let snapshot = {
    status: 'ok',
    updatedAt: new Date(FIXED_NOW).toISOString(),
    groups: [{
      name: 'Gemini',
      description: '',
      buckets: [
        { id: 'five_hour', name: '5h', window: '5h', remainingFraction: 0.25, resetTime: isoAfterHours(2) },
        { id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.1, resetTime: isoAfterHours(12) },
      ],
    }],
  }

  const { registered, mount, store } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      quota: async () => snapshot,
    },
  })

  const slot = registered.get('conversation.input.right')
  const view = mount(slot.Component, slot.meta.inject('session-colors'))
  await flush()

  // Weekly 10% (< 0.15) -> red (#d9534f); 5h 25% (< 0.35) -> amber (#e0a800)
  const pillBtn = findOne(view.tree, (n) => n.tag === 'button')
  assert.equal(textOf(pillBtn), '周 10%')
  pillBtn.props.onClick()
  await flush()

  const dialog = findOne(view.tree, (n) => n.props && n.props.role === 'dialog')
  const [primaryNode, secondaryNode] = findAll(dialog, (n) => n.props && 'data-bucket-role' in n.props)
  const primaryFill = findOne(primaryNode, (n) => n.tag === 'span' && n.props['aria-hidden'] === 'true').children[0]
  const secondaryFill = findOne(secondaryNode, (n) => n.tag === 'span' && n.props['aria-hidden'] === 'true').children[0]
  assert.equal(primaryFill.props.style.width, '10%')
  assert.equal(primaryFill.props.style.background, '#d9534f')
  assert.equal(secondaryFill.props.style.width, '25%')
  assert.equal(secondaryFill.props.style.background, '#e0a800')

  // Fallback to buckets[0] when plan has no weekly bucket
  snapshot = {
    status: 'ok',
    updatedAt: new Date(FIXED_NOW).toISOString(),
    groups: [{
      name: 'Gemini',
      description: '',
      buckets: [{ id: 'daily', name: '每日', window: '24h', remainingFraction: 0.5, resetTime: isoAfterHours(8) }],
    }],
  }
  const refreshBtn = findAll(dialog, (n) => n.tag === 'button')[0]
  refreshBtn.props.onClick()
  await flush()
  assert.equal(textOf(findOne(view.tree, (n) => n.tag === 'button')), '每日 50%')

  // Error state with empty buckets renders 周 !
  snapshot = { status: 'error', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [], error: 'agy unavailable' }
  const dialogAfterFallback = findOne(view.tree, (n) => n.props && n.props.role === 'dialog')
  findAll(dialogAfterFallback, (n) => n.tag === 'button')[0].props.onClick()
  await flush()
  assert.equal(textOf(findOne(view.tree, (n) => n.tag === 'button')), '周 !')

  // Switching away from antigravity hides QuotaPill completely
  store.setCurrent({ provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(view.tree, null)

  view.unmount()
})

test('Account quota drawer sorts weekly quota ahead of 5h window and collapses cleanly', async () => {
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => ({
        state: 'ready',
        version: '1.2.3',
        contextWindow: 1_048_576,
        configuredContextWindow: 0,
        defaultEffort: 'high',
        longDecodeContinuations: 3,
        unlock: { status: 'unlocked' },
        accounts: [
          { id: 'default', label: 'This Mac', system: true, enabled: true, state: 'ready', sessions: 0, email: 'user@example.com' },
        ],
      }),
      accounts: async () => [
        { id: 'default', label: 'This Mac', system: true, enabled: true, state: 'ready', sessions: 0, email: 'user@example.com' },
      ],
      quota: async () => ({
        status: 'ok',
        updatedAt: new Date(FIXED_NOW).toISOString(),
        groups: [{
          name: 'Gemini',
          description: '',
          buckets: [
            { id: 'five_hour', name: '5-hour', window: '5h', remainingFraction: 0.95, resetTime: isoAfterHours(4) },
            { id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.68, resetTime: isoAfterHours(62) },
          ],
        }],
      }),
      warmup: async () => ({ state: 'ready', version: '1.2.3', contextWindow: 1_048_576 }),
      configure: async (patch) => ({ state: 'ready', version: '1.2.3', contextWindow: 1_048_576, ...patch }),
    },
  })

  const settingsSlot = registered.get('settings.section')
  assert.ok(settingsSlot, 'SettingsCard should register on settings.section')
  const view = mount(settingsSlot.Component, settingsSlot.meta.inject())
  await flush()

  // Global top card has no quota buckets; quota lives per account and starts collapsed.
  assert.equal(findAll(view.tree, (n) => n.props && 'data-bucket-window' in n.props).length, 0)

  const quotaToggle = findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '额度')
  assert.ok(quotaToggle, 'signed-in account exposes an expandable 额度 button')
  quotaToggle.props.onClick()
  await flush()

  const bucketSpans = findAll(view.tree, (n) => n.props && 'data-bucket-window' in n.props)
  assert.deepEqual(bucketSpans.map((n) => n.props['data-bucket-window']), ['weekly', '5h'])
  assert.match(textOf(bucketSpans[0]), /每周.*68%/)
  assert.match(textOf(bucketSpans[1]), /5 小时.*95%/)

  // Clicking 额度 again collapses the drawer.
  findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '额度').props.onClick()
  await flush()
  assert.equal(findAll(view.tree, (n) => n.props && 'data-bucket-window' in n.props).length, 0)

  view.unmount()
})

test('Account quota drawer shows Claude quota beside Gemini and marks a paused 5h window', async () => {
  const quotaRequests = []
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => ({
        state: 'ready',
        version: '1.5.3',
        contextWindow: 900000,
        configuredContextWindow: 900000,
        defaultEffort: 'high',
        longDecodeContinuations: 8,
        unlock: { status: 'unlocked' },
        accounts: [
          { id: 'acc-1', label: '', system: false, enabled: true, state: 'idle', sessions: 0, email: 'later@example.com' },
        ],
      }),
      accounts: async () => [
        { id: 'acc-1', label: '', system: false, enabled: true, state: 'idle', sessions: 0, email: 'later@example.com' },
      ],
      quota: async (req) => {
        quotaRequests.push(req)
        return {
          status: 'ok',
          updatedAt: new Date(FIXED_NOW).toISOString(),
          groups: [
            {
              name: 'Gemini Models',
              description: '',
              buckets: [
                { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.95, resetTime: isoAfterHours(2) },
                { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.86, resetTime: isoAfterHours(140) },
              ],
            },
            {
              name: 'Claude and GPT models',
              description: '',
              buckets: [
                { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '' },
                { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0, resetTime: isoAfterHours(44), disabled: false },
              ],
            },
          ],
        }
      },
    },
  })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '额度').props.onClick()
  await flush()
  assert.equal(quotaRequests[0].accountId, 'acc-1')

  const rowFor = (label) => findOne(view.tree, (node) => {
    if (!node.props || node.props.className !== 'dsh-agy-row') return false
    const name = findOne(node, (child) => child.props && child.props.className === 'dsh-agy-label')
    return textOf(name) === label
  })
  const geminiRow = rowFor('Gemini 额度')
  const claudeRow = rowFor('Claude 额度')
  assert.ok(geminiRow, 'Gemini quota row is present inside the account drawer')
  assert.ok(claudeRow, 'Claude quota row is present inside the account drawer')

  const geminiWindows = findAll(geminiRow, (node) => node.props && 'data-bucket-window' in node.props)
  assert.deepEqual(geminiWindows.map((node) => node.props['data-bucket-window']), ['weekly', '5h'])
  assert.match(textOf(geminiWindows[0]), /每周.*86%/)
  assert.match(textOf(geminiWindows[1]), /5 小时.*95%/)

  const claudeWindows = findAll(claudeRow, (node) => node.props && 'data-bucket-window' in node.props)
  assert.deepEqual(claudeWindows.map((node) => node.props['data-bucket-window']), ['weekly', '5h'])
  assert.match(textOf(claudeWindows[0]), /每周.*0%/)
  assert.match(textOf(claudeWindows[0]), /1天20小时/)
  assert.equal(claudeWindows[1].props['data-bucket-disabled'], 'true')
  assert.match(textOf(claudeWindows[1]), /5 小时.*不适用/)
  assert.equal(textOf(claudeWindows[1]).includes('100%'), false)

  view.unmount()
})

test('QuotaPill follows the selected family: Claude and GPT use their own weekly bucket', async () => {
  const { registered, mount, store } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      quota: async () => ({
        status: 'ok',
        updatedAt: new Date(FIXED_NOW).toISOString(),
        groups: [
          {
            name: 'Gemini Models',
            description: '',
            buckets: [{ id: 'gemini_weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.62, resetTime: isoAfterHours(50) }],
          },
          {
            name: 'Claude and GPT models',
            description: '',
            buckets: [
              { id: 'claude_weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.46, resetTime: isoAfterHours(100) },
              { id: 'claude_5h', name: '5h', window: '5h', remainingFraction: 0.99, resetTime: isoAfterHours(2) },
            ],
          },
        ],
      }),
    },
  })
  store.setCurrent({ provider: 'antigravity', model: 'claude-opus-5-5' })
  const slot = registered.get('conversation.input.right')
  const view = mount(slot.Component, slot.meta.inject('session-claude'))
  await flush()
  const btn = findOne(view.tree, (n) => n.tag === 'button')
  assert.equal(textOf(btn), '周 46%')
  assert.equal(btn.props.title, 'Claude 与 GPT 每周额度 46%（4天4小时后重置） · 5 小时 99%')
  view.unmount()
})

function recordingService(windowValue = 0, decodeValue = 3, degradeValue = 'truncation', engineValue = 'bridge', compactionValue = true) {
  const patches = []
  const service = {
    status: async () => ({
      state: 'ready',
      version: '1.5.1',
      contextWindow: 1_048_576,
      configuredContextWindow: windowValue,
      defaultEffort: 'high',
      longDecodeContinuations: decodeValue,
      degradeAction: degradeValue,
      engineMode: engineValue,
      realUsageCompaction: compactionValue,
      unlock: { status: 'unlocked' },
    }),
    quota: async () => ({ status: 'ok', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [] }),
    warmup: async () => ({ state: 'ready', version: '1.5.1', contextWindow: 1_048_576 }),
    configure: async (patch) => {
      patches.push(patch)
      if ('contextWindow' in patch) windowValue = patch.contextWindow
      if ('longDecodeContinuations' in patch) decodeValue = patch.longDecodeContinuations
      if ('degradeAction' in patch) degradeValue = patch.degradeAction
      if ('engineMode' in patch) engineValue = patch.engineMode
      if ('realUsageCompaction' in patch) compactionValue = patch.realUsageCompaction
      return service.status()
    },
  }
  return { service, patches }
}

test('SettingsCard edits, cancels, resets and saves display aliases without losing offline models or failed drafts', async () => {
  let status = { state: 'ready', displayName: 'Antigravity', modelDisplayNames: { offline: 'Saved offline' }, availableModels: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon', enabled: true }], accounts: [] }
  let reject = false, resolveSave
  const patches = []
  const { registered, mount } = loadClientPlugin({ remoteService: {
    status: async () => status,
    configure: async (patch) => {
      patches.push(JSON.parse(JSON.stringify(patch)))
      if (reject) throw new Error('profile refused')
      if (resolveSave === null) await new Promise(resolve => { resolveSave = resolve })
      status = { ...status, ...patch }
      return status
    },
  } })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  const button = (text) => findOne(view.tree, n => n.tag === 'button' && textOf(n) === text)
  const field = (label) => findOne(view.tree, n => n.tag === 'input' && n.props['aria-label'] === label)
  await flush()
  button('编辑别名').props.onClick(); await flush()
  field('分组别名').props.onChange({ target: { value: 'My Google' } })
  field('模型别名 gemini-4-argon').props.onChange({ target: { value: 'My Reasoner' } }); await flush()
  button('取消').props.onClick(); await flush()
  assert.equal(patches.length, 0)
  button('编辑别名').props.onClick(); await flush()
  assert.equal(field('分组别名').props.value, 'Antigravity')
  field('分组别名').props.onChange({ target: { value: 'My Google' } })
  field('模型别名 gemini-4-argon').props.onChange({ target: { value: 'My Reasoner' } }); await flush()
  reject = true; button('保存别名').props.onClick(); await flush()
  assert.match(textOf(view.tree), /profile refused/)
  assert.equal(field('模型别名 gemini-4-argon').props.value, 'My Reasoner')
  reject = false; resolveSave = null
  const save = button('保存别名'); save.props.onClick(); save.props.onClick(); await flush()
  assert.equal(patches.length, 2, 'one failed request plus one in-flight request, no double submit')
  assert.ok(findOne(view.tree, n => n.tag === 'fieldset' && n.props.disabled === true))
  resolveSave(); await flush()
  assert.equal(patches[1].modelDisplayNames.offline, 'Saved offline')
  assert.equal(patches[1].modelDisplayNames['gemini-4-argon'], 'My Reasoner')
  button('编辑别名').props.onClick(); await flush()
  button('重置别名').props.onClick(); await flush()
  assert.equal(field('分组别名').props.value, '')
  button('保存别名').props.onClick(); await flush()
  assert.deepEqual(patches[2], { displayName: '', modelDisplayNames: {} })
  view.unmount()
})

test('SettingsCard renders live settings as value rows that apply the chosen option', async () => {
  const { service, patches } = recordingService()
  const { registered, mount } = loadClientPlugin({ language: 'zh-CN', remoteService: service })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  const rows = findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)
  assert.deepEqual(rows.map(textOf), [
    '上下文窗口自动 (1M)',
    '默认思考High',
    '超长续写3 段',
    '降智处理128K截断重答',
    '引擎模式DSH 工具桥接',
    '压缩触发计量按真实账单校准（推荐）',
  ])
  assert.equal(rows.every((row) => row.props.disabled === false), true)
  const hint = (row) => findOne(row, (node) => node.props && node.props.className === 'dsh-agy-hint')
  const hintText = (row) => findOne(row, (node) => node.props && node.props['data-tooltip'] !== undefined).props['data-tooltip']
  assert.ok(hint(rows[2]), 'the label carries the hint glyph')
  assert.match(hintText(rows[2]), /自动接着写/)
  assert.match(hintText(rows[3]), /128K截断重答/)
  assert.match(hintText(rows[4]), /谁来读文件/)
  assert.match(hintText(rows[5]), /真实计费 token/)

  // The row opens the choice list inline; the current value carries the check.
  rows[0].props.onClick()
  await flush()
  const options = findAll(view.tree, (node) => node.tag === 'button' && node.props['aria-checked'] !== undefined)
  assert.deepEqual(options.map(textOf), ['自动 (1M)', '1M', '900K', '512K', '256K'])
  assert.equal(options[0].props['aria-checked'], true)

  options[3].props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ contextWindow: 512000 }])
  assert.match(textOf(findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)[0]), /上下文窗口512K/)

  // The list collapses after a choice and the next row applies its own patch.
  assert.equal(findAll(view.tree, (node) => node.props['aria-checked'] !== undefined).length, 0)
  findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)[2].props.onClick()
  await flush()
  findAll(view.tree, (node) => node.tag === 'button' && node.props['aria-checked'] !== undefined)[2].props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ contextWindow: 512000 }, { longDecodeContinuations: 8 }])
  view.unmount()
})

test('composer parameter rows expose the same live settings for Antigravity only', async () => {
  const { service, patches } = recordingService()
  const { registered, mount, store } = loadClientPlugin({ language: 'zh-CN', remoteService: service })
  const slot = registered.get('conversation.input.model.parameters')
  assert.ok(slot, 'the plugin registers the composer parameter slot')
  const owner = { locked: false, dismiss() {}, reportFailure() {} }
  const view = mount(slot.Component, { ...slot.meta.inject('session-params'), ...owner })
  await flush()

  const rows = findAll(view.tree, (node) => node.props && node.props.role === 'menuitem')
  assert.deepEqual(rows.map(textOf), ['上下文自动 (1M)', '超长续写3 段'])

  rows[0].props.onClick()
  await flush()
  const options = findAll(view.tree, (node) => node.props.role === 'menuitemradio')
  assert.deepEqual(options.map(textOf), ['自动 (1M)', '1M', '900K', '512K', '256K'])
  assert.equal(options[0].props['aria-checked'], true)
  options[2].props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ contextWindow: 900000 }])
  assert.match(textOf(findAll(view.tree, (node) => node.props.role === 'menuitem')[0]), /900K/)

  // Locked rows refuse changes.
  view.unmount()
  const locked = mount(slot.Component, { ...slot.meta.inject('session-params'), ...owner, locked: true })
  await flush()
  const lockedRows = findAll(locked.tree, (node) => node.props && node.props.role === 'menuitem')
  assert.equal(lockedRows.every((row) => row.props.disabled === true), true)
  lockedRows[0].props.onClick()
  await flush()
  assert.equal(patches.length, 1, 'a locked row applies nothing')
  locked.unmount()

  // Another provider renders nothing.
  store.setCurrent({ provider: 'deepseek', model: 'deepseek-chat' })
  const other = mount(slot.Component, { ...slot.meta.inject('session-params'), ...owner })
  await flush()
  assert.equal(other.tree, null)
  other.unmount()
})

test('ModelParameterRows keeps the two panels mutually exclusive (accordion)', async () => {
  const { service } = recordingService()
  const { registered, mount } = loadClientPlugin({ language: 'zh-CN', remoteService: service })
  const slot = registered.get('conversation.input.model.parameters')
  const owner = { locked: false, dismiss() {}, reportFailure() {} }
  const view = mount(slot.Component, { ...slot.meta.inject('session-accordion'), ...owner })
  await flush()

  const menuRows = () => findAll(view.tree, (node) => node.props && node.props.role === 'menuitem')
  const radios = () => findAll(view.tree, (node) => node.props && node.props.role === 'menuitemradio')

  // Opening "上下文" renders its 5 choices and leaves "超长续写" collapsed.
  menuRows()[0].props.onClick()
  await flush()
  assert.equal(radios().length, 5)
  assert.equal(menuRows()[0].props['aria-expanded'], true)
  assert.equal(menuRows()[1].props['aria-expanded'], false)

  // Clicking "超长续写" folds "上下文" away; only the 3 decode choices remain.
  menuRows()[1].props.onClick()
  await flush()
  assert.equal(menuRows()[0].props['aria-expanded'], false)
  assert.equal(menuRows()[1].props['aria-expanded'], true)
  assert.equal(radios().length, 3)
  assert.deepEqual(radios().map(textOf), ['关闭', '3 段', '8 段'])

  view.unmount()
})

test('ModelParameterRows collapses on outside pointerdown and on the first Escape', async () => {
  const { service } = recordingService()
  const { registered, mount, document } = loadClientPlugin({ language: 'zh-CN', remoteService: service })
  const slot = registered.get('conversation.input.model.parameters')
  const owner = { locked: false, dismiss() {}, reportFailure() {} }
  const view = mount(slot.Component, { ...slot.meta.inject('session-collapse'), ...owner })
  await flush()

  const menuRows = () => findAll(view.tree, (node) => node.props && node.props.role === 'menuitem')
  const radios = () => findAll(view.tree, (node) => node.props && node.props.role === 'menuitemradio')

  // A pointerdown outside the list closes the expanded panel.
  menuRows()[0].props.onClick()
  await flush()
  assert.equal(radios().length, 5)
  document.dispatch('pointerdown', { target: {} })
  assert.equal(radios().length, 0)
  assert.equal(menuRows()[0].props['aria-expanded'], false)

  // The first Escape collapses the sub-list AND stops propagation so the
  // enclosing model menu stays open (it closes only on a second Escape).
  menuRows()[1].props.onClick()
  await flush()
  assert.equal(radios().length, 3)
  let prevented = 0
  let stopped = 0
  view.tree.props.onKeyDown({
    key: 'Escape',
    preventDefault() { prevented += 1 },
    stopPropagation() { stopped += 1 },
  })
  assert.equal(prevented, 1, 'first Escape calls preventDefault')
  assert.equal(stopped, 1, 'first Escape calls stopPropagation')
  assert.equal(radios().length, 0)
  assert.equal(menuRows()[1].props['aria-expanded'], false)

  // With no sub-list open, a second Escape no longer stops propagation: the
  // event is free to reach the model menu and close it.
  prevented = 0
  stopped = 0
  view.tree.props.onKeyDown({
    key: 'Escape',
    preventDefault() { prevented += 1 },
    stopPropagation() { stopped += 1 },
  })
  assert.equal(prevented, 0)
  assert.equal(stopped, 0)

  // Document-capture Escape also collapses the open sub-list even when focus
  // stayed on the outer ModelSelect trigger button.
  menuRows()[0].props.onClick()
  await flush()
  assert.equal(radios().length, 5)
  document.dispatch('keydown', {
    key: 'Escape',
    preventDefault() { prevented += 1 },
    stopPropagation() { stopped += 1 },
  })
  assert.equal(prevented, 1, 'document Escape calls preventDefault while expanded')
  assert.equal(stopped, 1, 'document Escape calls stopPropagation while expanded')
  assert.equal(radios().length, 0)
  assert.equal(menuRows()[0].props['aria-expanded'], false)

  view.unmount()
})

test('SettingsCard keeps its four choice rows mutually exclusive', async () => {
  const { service } = recordingService()
  const { registered, mount } = loadClientPlugin({ language: 'zh-CN', remoteService: service })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  const expandedRows = () => findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)
  const choices = () => findAll(view.tree, (node) => node.tag === 'button' && node.props['aria-checked'] !== undefined)

  // Open "上下文窗口" -> its 5 window choices are shown.
  expandedRows()[0].props.onClick()
  await flush()
  assert.equal(choices().length, 5)
  assert.equal(expandedRows()[0].props['aria-expanded'], true)

  // Click "默认思考" -> the window panel folds away, only the 4 efforts show.
  expandedRows()[1].props.onClick()
  await flush()
  assert.equal(expandedRows()[0].props['aria-expanded'], false)
  assert.equal(expandedRows()[1].props['aria-expanded'], true)
  assert.equal(choices().length, 4)
  assert.deepEqual(choices().map(textOf), ['Low', 'Medium', 'High', 'XHigh'])

  // Click "超长续写" -> the effort panel folds away, only the 3 decodes show.
  expandedRows()[2].props.onClick()
  await flush()
  assert.equal(expandedRows()[1].props['aria-expanded'], false)
  assert.equal(expandedRows()[2].props['aria-expanded'], true)
  assert.equal(choices().length, 3)
  assert.deepEqual(choices().map(textOf), ['关闭', '3 段', '8 段'])

  // Click "降智处理" -> the decode panel folds away, only the 3 levels show.
  expandedRows()[3].props.onClick()
  await flush()
  assert.equal(expandedRows()[2].props['aria-expanded'], false)
  assert.equal(expandedRows()[3].props['aria-expanded'], true)
  assert.deepEqual(choices().map(textOf), ['128K截断重答', '全量降智拦截重答', '仅监测提示'])

  // Click "引擎模式" -> the degrade panel folds away, only the 2 engine modes show.
  expandedRows()[4].props.onClick()
  await flush()
  assert.equal(expandedRows()[3].props['aria-expanded'], false)
  assert.equal(expandedRows()[4].props['aria-expanded'], true)
  assert.deepEqual(choices().map(textOf), ['DSH 工具桥接', '原生 Agent（满血）'])

  // Click "压缩触发计量" -> the engine panel folds away, only the 2 compaction modes show.
  expandedRows()[5].props.onClick()
  await flush()
  assert.equal(expandedRows()[4].props['aria-expanded'], false)
  assert.equal(expandedRows()[5].props['aria-expanded'], true)
  assert.deepEqual(choices().map(textOf), ['按真实账单校准（推荐）', 'DSH 默认字符估算'])

  view.unmount()
})

test('SettingsCard switches the degraded-route level, engine mode, and compaction meter live through configure', async () => {
  const { service, patches } = recordingService()
  const { registered, mount } = loadClientPlugin({ language: 'en-US', remoteService: service })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  const degradeRow = () => findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)[3]
  const engineRow = () => findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)[4]
  const compactionRow = () => findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)[5]
  assert.equal(textOf(degradeRow()), 'Degraded routeRe-answer on 128K truncation')
  assert.equal(textOf(engineRow()), 'Engine modeDSH tool bridge')
  assert.equal(textOf(compactionRow()), 'Compaction meterReal billed usage (recommended)')
  degradeRow().props.onClick()
  await flush()
  const options = findAll(view.tree, (node) => node.tag === 'button' && node.props['aria-checked'] !== undefined)
  assert.deepEqual(options.map(textOf), ['Re-answer on 128K truncation', 'Re-answer on any flag', 'Observe only'])
  assert.equal(options[0].props['aria-checked'], true)
  options[2].props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ degradeAction: 'observe' }])
  assert.equal(textOf(degradeRow()), 'Degraded routeObserve only')

  engineRow().props.onClick()
  await flush()
  const engineChoices = findAll(view.tree, (node) => node.tag === 'button' && node.props['aria-checked'] !== undefined)
  assert.deepEqual(engineChoices.map(textOf), ['DSH tool bridge', 'Native agent (full strength)'])
  assert.equal(engineChoices[0].props['aria-checked'], true)
  engineChoices[1].props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ degradeAction: 'observe' }, { engineMode: 'native' }])
  assert.equal(textOf(engineRow()), 'Engine modeNative agent (full strength)')

  compactionRow().props.onClick()
  await flush()
  const compactionChoices = findAll(view.tree, (node) => node.tag === 'button' && node.props['aria-checked'] !== undefined)
  assert.deepEqual(compactionChoices.map(textOf), ['Real billed usage (recommended)', 'DSH heuristic default'])
  assert.equal(compactionChoices[0].props['aria-checked'], true)
  compactionChoices[1].props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [
    { degradeAction: 'observe' },
    { engineMode: 'native' },
    { realUsageCompaction: false },
  ])
  assert.equal(textOf(compactionRow()), 'Compaction meterDSH heuristic default')
  view.unmount()
})

test('SettingsCard paints status with interactive choice rows while quota is still pending', async () => {
  let resolveQuota
  const pendingQuota = new Promise((resolve) => { resolveQuota = resolve })
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => ({
        state: 'ready',
        version: '1.2.3',
        contextWindow: 1_048_576,
        configuredContextWindow: 0,
        defaultEffort: 'high',
        longDecodeContinuations: 3,
        unlock: { status: 'unlocked' },
      }),
      // A slow / unresolved quota read must NOT hold the status rows hostage.
      quota: () => pendingQuota,
    },
  })

  const settingsSlot = registered.get('settings.section')
  assert.ok(settingsSlot, 'SettingsCard should register on settings.section')
  const view = mount(settingsSlot.Component, settingsSlot.meta.inject())
  await flush()

  // The status half is already on screen ...
  assert.match(textOf(view.tree), /已连接/)
  const rows = findAll(view.tree, (node) => node.props && node.props['aria-expanded'] !== undefined)
  assert.equal(rows.length, 6, 'all six choice rows render before quota resolves')
  assert.deepEqual(rows.map(textOf), [
    '上下文窗口自动 (1M)',
    '默认思考High',
    '超长续写3 段',
    '降智处理128K截断重答',
    '引擎模式DSH 工具桥接',
    '压缩触发计量按真实账单校准（推荐）',
  ])
  assert.equal(rows.every((row) => row.props.disabled === false), true,
    'a slow quota read must never disable or fade out the choice rows')
  // ... while the quota chips correctly have not appeared yet.
  assert.equal(findAll(view.tree, (n) => n.props && 'data-bucket-window' in n.props).length, 0)

  resolveQuota({ status: 'ok', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [] })
  await flush()
  view.unmount()
})

test('AccountsPanel renders account cards, forwards SmallButton style, and supports add + sign-in ticket', async () => {
  const accounts = [
    { id: 'system', system: true, label: '', email: 'me@example.com', state: 'ready', sessions: 2, enabled: true, cooldowns: [] },
    { id: 'acc-1', system: false, label: 'Work', email: '', state: 'idle', sessions: 0, enabled: true, cooldowns: [] },
  ]
  let configured = null
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => ({
        state: 'ready', version: '1.2.3', contextWindow: 1_048_576,
        configuredContextWindow: 0, defaultEffort: 'high', longDecodeContinuations: 3,
        unlock: { status: 'unlocked' }, accounts,
      }),
      quota: async () => ({ status: 'ok', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [] }),
      configure: async (patch) => {
        configured = patch
        return {
          state: 'ready', version: '1.2.3', contextWindow: 1_048_576,
          configuredContextWindow: 0, defaultEffort: 'high', longDecodeContinuations: 3,
          unlock: { status: 'unlocked' }, accounts: patch.accounts || accounts,
        }
      },
      login: async () => ({ url: 'https://example.com/auth', command: 'agy login --code ABC' }),
    },
  })

  const settingsSlot = registered.get('settings.section')
  const view = mount(settingsSlot.Component, settingsSlot.meta.inject())
  await flush()

  // One card per configured account, with the local-machine and 默认 badges.
  const cards = findAll(view.tree, (n) => n.props && 'data-agy-account' in n.props)
  assert.deepEqual(cards.map((n) => n.props['data-agy-account']), ['system', 'acc-1'])
  assert.equal(cards[0].props.className, 'dsh-agy-account-card')
  assert.match(textOf(cards[0]), /本机/)
  assert.match(textOf(cards[0]), /默认/, 'the system account keeps its 默认 badge')
  assert.doesNotMatch(textOf(cards[0]), /已连接|待命|启动中|异常/, 'no per-account state pill on the system card')
  assert.doesNotMatch(textOf(cards[1]), /已连接|待命|启动中|异常/, 'no per-account state pill on the secondary card')
  assert.match(textOf(view.tree), /已连接/, 'the top-level global status badge is retained')
  assert.match(textOf(cards[0]), /编辑/)
  assert.match(textOf(cards[1]), /Work/)
  assert.match(textOf(cards[1]), /登录/)
  assert.match(textOf(view.tree), /共 2 个/, 'a count pill should label the accounts section')

  // A signed-in account edits its own proxy, context, and models. Sign-in stays
  // on accounts that have no credential yet.
  findOne(cards[0], (n) => n.tag === 'button' && textOf(n) === '编辑').props.onClick()
  await flush()
  assert.ok(findOne(view.tree, (n) => n.tag === 'input' && n.props['aria-label'] === '代理'))
  assert.ok(findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '保存'))
  assert.ok(findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '重新登录'))

  // The machine row is always enabled and cannot be disabled, but it can be
  // removed from the list (after a confirmation), so it carries no 停用 switch.
  assert.equal(findOne(cards[0], (n) => n.tag === 'button' && textOf(n) === '停用'), null,
    'the machine row is always enabled')
  const systemRemove = findOne(cards[0], (n) => n.tag === 'button' && textOf(n) === '移除')
  assert.ok(systemRemove, 'the machine row offers removal')
  assert.ok(String(systemRemove.props.className).includes('dsh-agy-btn-danger'))

  // SmallButton must forward props.style: previously padding and the danger red
  // were silently dropped, leaving an unstyled remove button.
  const dangerBtn = findOne(cards[1], (n) => n.tag === 'button'
    && typeof n.props.className === 'string' && n.props.className.includes('dsh-agy-btn-danger'))
  assert.ok(dangerBtn, 'a declared account keeps its delete button')
  assert.equal(textOf(dangerBtn), '删除')
  assert.equal(dangerBtn.props.style.padding, '4px 10px', 'SmallButton must forward props.style')
  assert.equal(dangerBtn.props.style.color, '#d9534f')

  // The add row is pixel-level equal height (34px) for input and button.
  const remarkInput = findOne(view.tree, (n) => n.tag === 'input' && n.props.placeholder === '备注名称（可选）')
  assert.ok(remarkInput)
  assert.equal(remarkInput.props.style.height, 34)
  const addBtn = findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '添加账号')
  assert.ok(addBtn)
  assert.equal(addBtn.props.style.height, 34)
  assert.ok(String(addBtn.props.className).includes('dsh-agy-btn-primary'))

  // Adding an account rebuilds the whole list through configure(), and the
  // machine row travels with it instead of being dropped from the save.
  remarkInput.props.onChange({ target: { value: 'New account' } })
  findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '添加账号').props.onClick()
  await flush()
  assert.ok(configured, 'configure should be called when an account is added')
  assert.equal(configured.accounts.length, 3, 'the machine row stays in the submitted list')
  assert.equal(configured.accounts[0].id, 'system')
  assert.equal(configured.accounts[0].system, true, 'the machine row keeps its system marker')
  assert.equal(configured.accounts[0].displayName, '', 'the machine default label is never stored as a remark')
  assert.equal(configured.accounts[1].id, 'acc-1')
  assert.equal(configured.accounts[2].displayName, 'New account')

  // Clicking 登录 reveals the inline authorization panel.
  const loginBtn = findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '登录')
  assert.ok(loginBtn)
  loginBtn.props.onClick()
  await flush()
  const authLink = findOne(view.tree, (n) => n.tag === 'a')
  assert.ok(authLink, 'sign-in should reveal the authorization link panel')
  assert.equal(authLink.props.href, 'https://example.com/auth')
  assert.ok(findOne(view.tree, (n) => n.tag === 'input' && n.props['aria-label'] === '授权码'),
    'the authorization code field should be present')
  const submitBtn = findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '提交')
  assert.ok(submitBtn)
  assert.ok(String(submitBtn.props.className).includes('dsh-agy-btn-primary'))
  assert.equal(submitBtn.props.style.height, 34)

  view.unmount()
})

test('the sign-in ticket copies its link and terminal command from their own rows', async () => {
  const writes = []
  const url = 'https://accounts.google.com/o/oauth2/auth?client_id=abc&code_challenge=xyz'
  const command = 'HOME=/tmp/acc-qih25eai /usr/local/bin/agy acp --login'
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    clipboard: { writeText: async (text) => { writes.push(String(text)) } },
    remoteService: {
      status: async () => accountsStatus([
        accountRow('acc-1', { state: 'idle', email: undefined }),
      ]),
      quota: async () => ({ status: 'ok', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [] }),
      login: async () => ({ url, command }),
    },
  })

  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()
  findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '登录').props.onClick()
  await flush()

  // Each read-only line is its own flex row: the text keeps the free width and
  // the copy control keeps its own, so a long URL never pushes it out of view.
  const rows = findAll(view.tree, (n) => n.props && 'data-agy-ticket' in n.props)
  assert.deepEqual(rows.map((n) => n.props['data-agy-ticket']), ['link', 'command'])
  assert.equal(rows.every((n) => n.props.className === 'dsh-agy-ticket-row'), true)
  const copyButtons = findAll(view.tree, (n) => n.tag === 'button' && n.props['data-agy-copy'] !== undefined)
  assert.deepEqual(copyButtons.map((n) => n.props['data-agy-copy']), ['link', 'command'])
  assert.deepEqual(copyButtons.map((n) => n.props['aria-label']), ['复制授权链接', '复制终端命令'])
  assert.ok(findOne(rows[0], (n) => n.tag === 'button' && n.props['data-agy-copy'] === 'link'),
    'the link row owns the link copy action')
  assert.ok(findOne(rows[1], (n) => n.tag === 'button' && n.props['data-agy-copy'] === 'command'),
    'the command row owns the command copy action')

  // Copying is per line, reports success on the button itself, and never
  // disturbs the surrounding card.
  findOne(rows[0], (n) => n.tag === 'button' && n.props['data-agy-copy'] === 'link').props.onClick()
  await flush()
  assert.deepEqual(writes, [url])
  const copied = findOne(view.tree, (n) => n.tag === 'button' && n.props['data-agy-copy'] === 'link')
  assert.equal(copied.props['data-copied'], 'true')
  assert.equal(copied.props['aria-label'], '已复制')
  assert.equal(copied.props.title, '已复制')
  assert.ok(findOne(copied, (n) => n.props && n.props.className === 'dsh-agy-check'),
    'the copied state swaps in the check glyph')

  findOne(view.tree, (n) => n.tag === 'button' && n.props['data-agy-copy'] === 'command').props.onClick()
  await flush()
  assert.deepEqual(writes, [url, command])
  assert.equal(findOne(view.tree, (n) => n.props && n.props.className === 'dsh-agy-ticket-command').props.children[0], command)
  assert.ok(findOne(view.tree, (n) => n.tag === 'input' && n.props['aria-label'] === '授权码'),
    'the paste field survives the added controls')

  view.unmount()
})

test('AccountsPanel defaults an unnamed signed-in account title to its email instead of 未命名', async () => {
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => ({
        state: 'ready',
        version: '1.5.3',
        contextWindow: 1_048_576,
        configuredContextWindow: 0,
        defaultEffort: 'high',
        longDecodeContinuations: 3,
        models: [],
        availableModels: [],
        visibleModels: [],
        accounts: [
          { id: 'acc-1', label: '', system: false, enabled: true, state: 'idle', sessions: 0, email: 'member@example.com', visibleModels: [] },
          { id: 'acc-2', label: '', system: false, enabled: true, state: 'idle', sessions: 0, email: undefined, visibleModels: [] },
        ],
      }),
      accounts: async () => [
        { id: 'acc-1', label: '', system: false, enabled: true, state: 'idle', sessions: 0, email: 'member@example.com', visibleModels: [] },
        { id: 'acc-2', label: '', system: false, enabled: true, state: 'idle', sessions: 0, email: undefined, visibleModels: [] },
      ],
    },
  })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()
  const cards = findAll(view.tree, (n) => n.props && 'data-agy-account' in n.props)
  const titleOf = (card) => textOf(findOne(card, (n) => n.props && n.props.className === 'dsh-agy-account-title'))
  assert.equal(titleOf(cards[0]), 'member@example.com', 'an unnamed signed-in account defaults its title to email')
  assert.doesNotMatch(textOf(cards[0]), /未命名/)
  assert.doesNotMatch(textOf(cards[0]), /未登录/)
  assert.equal(titleOf(cards[1]), '未命名', 'an unnamed signed-out account still shows 未命名')
  view.unmount()
})

// ── The account list is the whole truth: the machine row travels with it ─────

/** One reported account row, machine or declared. */
const accountRow = (id, extra = {}) => ({
  id,
  label: '',
  system: false,
  enabled: true,
  state: 'idle',
  sessions: 0,
  email: undefined,
  home: '',
  env: {},
  contextWindow: 0,
  visibleModels: [],
  priority: 1,
  weight: 1,
  ...extra,
})

/** This Mac's own row, as the Host reports it while it is in the list. */
const machineRow = (extra = {}) => accountRow('default', {
  label: 'This Mac',
  system: true,
  state: 'ready',
  email: 'me@example.com',
  ...extra,
})

const accountsStatus = (accounts) => ({
  state: 'ready',
  version: '1.2.3',
  contextWindow: 1_048_576,
  configuredContextWindow: 0,
  defaultEffort: 'high',
  longDecodeContinuations: 3,
  unlock: { status: 'unlocked' },
  accounts,
})

/** Mount the Settings card over a fixed account list and record every configure(). */
const mountAccounts = async (accounts) => {
  const patches = []
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => accountsStatus(accounts),
      accounts: async () => accounts,
      quota: async () => ({ status: 'ok', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [] }),
      configure: async (patch) => {
        patches.push(patch)
        return accountsStatus(patch.accounts || accounts)
      },
    },
  })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()
  return { view, patches }
}

const accountCards = (view) => findAll(view.tree, (n) => n.props && 'data-agy-account' in n.props)

test('removing a declared account submits the list with the machine row still in it', async () => {
  const { view, patches } = await mountAccounts([
    machineRow(),
    accountRow('acc-1', { label: 'Work', email: 'work@example.com' }),
  ])
  const cards = accountCards(view)
  assert.equal(cards.length, 2)
  findOne(cards[1], (n) => n.tag === 'button' && textOf(n) === '删除').props.onClick()
  await flush()

  assert.equal(patches.length, 1)
  assert.equal(patches[0].accounts.length, 1, 'only the declared account leaves the list')
  assert.equal(patches[0].accounts[0].id, 'default')
  assert.equal(patches[0].accounts[0].system, true)
  assert.equal(patches[0].accounts[0].displayName, '', 'the machine label is not frozen into a remark')
  view.unmount()
})

test('editing the machine account submits the whole list through accounts', async () => {
  const { view, patches } = await mountAccounts([
    machineRow(),
    accountRow('acc-1', { label: 'Work', email: 'work@example.com' }),
  ])
  findOne(accountCards(view)[0], (n) => n.tag === 'button' && textOf(n) === '编辑').props.onClick()
  await flush()

  const modal = findOne(view.tree, (n) => n.props && n.props['data-agy-editor-modal'] === 'default')
  assert.ok(modal, 'the machine row opens the same editor')
  const remark = findOne(modal, (n) => n.tag === 'input' && n.props['aria-label'] === '账号备注')
  assert.ok(remark, 'the machine row remark is editable')
  assert.ok(findOne(modal, (n) => n.tag === 'input' && n.props['aria-label'] === '代理'), 'its proxy stays editable')
  remark.props.onChange({ target: { value: '公司本机' } })
  findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '保存').props.onClick()
  await flush()

  assert.equal(patches.length, 1)
  assert.equal(Object.hasOwn(patches[0], 'systemProfile'), false, 'the retired field is never sent')
  assert.equal(patches[0].accounts.length, 2, 'the declared account is carried along untouched')
  assert.equal(patches[0].accounts[0].id, 'default')
  assert.equal(patches[0].accounts[0].system, true)
  assert.equal(patches[0].accounts[0].displayName, '公司本机', 'the machine row remark is stored')
  assert.equal(patches[0].accounts[1].id, 'acc-1')
  assert.equal(patches[0].accounts[1].displayName, 'Work')
  view.unmount()
})

test('removing the machine account asks for a second click before it is submitted', async () => {
  const { view, patches } = await mountAccounts([
    machineRow(),
    accountRow('acc-1', { label: 'Work', email: 'work@example.com' }),
  ])
  const machineCard = () => accountCards(view)[0]

  findOne(machineCard(), (n) => n.tag === 'button' && textOf(n) === '移除').props.onClick()
  await flush()
  assert.equal(patches.length, 0, 'the first click only asks')
  assert.ok(findOne(machineCard(), (n) => n.tag === 'button' && textOf(n) === '确认移除'), 'the confirmation is inline')

  findOne(machineCard(), (n) => n.tag === 'button' && textOf(n) === '取消').props.onClick()
  await flush()
  assert.equal(patches.length, 0, 'cancel submits nothing')
  assert.ok(findOne(machineCard(), (n) => n.tag === 'button' && textOf(n) === '移除'), 'cancel puts the button back')

  findOne(machineCard(), (n) => n.tag === 'button' && textOf(n) === '移除').props.onClick()
  await flush()
  findOne(machineCard(), (n) => n.tag === 'button' && textOf(n) === '确认移除').props.onClick()
  await flush()
  assert.equal(patches.length, 1, 'the confirmed removal is the only save')
  assert.equal(patches[0].accounts.length, 1)
  assert.equal(patches[0].accounts[0].id, 'acc-1')
  view.unmount()
})

test("the accounts panel offers Use this Mac's login when the list has no machine row", async () => {
  const { view, patches } = await mountAccounts([accountRow('acc-1', { label: 'Work', email: 'work@example.com' })])
  assert.equal(findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '移除'), null)
  const useMac = findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '使用本机登录')
  assert.ok(useMac, 'the machine row can be added back')
  useMac.props.onClick()
  await flush()

  assert.equal(patches.length, 1)
  assert.equal(patches[0].accounts.length, 2)
  const head = patches[0].accounts[0]
  assert.equal(head.id, 'default')
  assert.equal(head.system, true)
  assert.equal(head.displayName, '')
  assert.equal(head.home, '')
  assert.equal(head.enabled, true)
  assert.equal(Object.keys(head.env).length, 0)
  assert.equal(head.contextWindow, 0)
  assert.equal(head.visibleModels.length, 0)
  assert.equal(head.priority, 1)
  assert.equal(head.weight, 1)
  assert.equal(patches[0].accounts[1].id, 'acc-1', 'the declared account keeps its place after it')
  assert.equal(findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '使用本机登录'), null,
    'the entry point disappears once the list carries the machine row')
  view.unmount()
})

test('an unloaded account list offers no save and never submits an empty list', async () => {
  const patches = []
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      // The Host answered status before it reported any account list.
      status: async () => ({
        state: 'ready',
        version: '1.2.3',
        contextWindow: 1_048_576,
        configuredContextWindow: 0,
        defaultEffort: 'high',
        longDecodeContinuations: 3,
        unlock: { status: 'unlocked' },
      }),
      configure: async (patch) => {
        patches.push(patch)
        return accountsStatus(patch.accounts || [])
      },
    },
  })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  assert.match(textOf(view.tree), /账号列表尚未加载，请稍后重试/, 'the panel says why nothing can be saved yet')
  assert.equal(findAll(view.tree, (n) => n.props && 'data-agy-account' in n.props).length, 0, 'no card is invented')
  assert.equal(findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '使用本机登录'), null,
    'the machine-row entry point is not offered for an unknown list')

  const addBtn = findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '添加账号')
  assert.ok(addBtn)
  assert.equal(addBtn.props.disabled, true, 'the add action waits for the list')
  // Even when the click reaches the handler, the save itself is refused: an
  // empty list here would delete this Mac's own login with every other account.
  addBtn.props.onClick()
  await flush()
  assert.equal(patches.length, 0, 'nothing is submitted while the list is unloaded')
  assert.match(textOf(view.tree), /账号列表尚未加载，请稍后重试/)

  view.unmount()
})

// ── Shared model selection: two entry points and the account subset ──────────

const catalogStatus = (visibleModels) => ({
  state: 'ready',
  version: '1.2.3',
  contextWindow: 1_048_576,
  configuredContextWindow: 0,
  defaultEffort: 'high',
  longDecodeContinuations: 3,
  models: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
  availableModels: [
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon', enabled: visibleModels.length === 0 || visibleModels.includes('gemini-4-argon') },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', enabled: visibleModels.length === 0 || visibleModels.includes('claude-opus-5-5') },
  ],
  visibleModels,
  accounts: [
    {
      id: 'acc-1',
      label: 'Work',
      system: false,
      enabled: true,
      root: '/tmp/acc-1',
      home: '',
      env: {},
      homeDir: '/tmp/acc-1/home',
      geminiDir: '/tmp/acc-1/gemini',
      state: 'idle',
      cooldowns: [],
      sessions: 0,
      email: 'work@example.com',
      contextWindow: 0,
      visibleModels: [],
    },
  ],
})

test('the Antigravity card registers on the Models page and summarizes the allowlist', async () => {
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: { status: async () => catalogStatus(['claude-opus-5-5']) },
  })
  const slot = registered.get('settings.models.provider-card')
  assert.ok(slot, 'the selection block registers on settings.models.provider-card')
  assert.equal(slot.meta.key, 'llm-antigravity-acp')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()
  assert.match(textOf(view.tree), /已选 1 \/ 2 个模型/)
  assert.match(textOf(view.tree), /claude-opus-5-5/)
  assert.ok(!textOf(view.tree).includes('gemini-4-argon'), 'a hidden family stays off the selected rows')
  view.unmount()
})

test('fetching the catalog writes the provider allowlist through configure', async () => {
  const patches = []
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => catalogStatus([]),
      warmup: async () => catalogStatus([]),
      configure: async (patch) => {
        patches.push(patch)
        return catalogStatus(patch.visibleModels || [])
      },
    },
  })
  const slot = registered.get('settings.models.provider-card')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()
  const fetch = findAll(view.tree, (node) => node.tag === 'button' && textOf(node).includes('获取可用模型'))[0]
  fetch.props.onClick()
  await flush()
  const dialog = findOne(view.tree, (node) => node.props && node.props.role === 'dialog')
  assert.ok(dialog, 'fetch models opens the selection modal')
  const checks = findAll(dialog, (node) => node.props && node.props.type === 'checkbox')
  assert.equal(checks.length, 2)
  checks[1].props.onChange()
  await flush()
  const reopened = findOne(view.tree, (node) => node.props && node.props.role === 'dialog')
  const update = findAll(reopened, (node) => node.tag === 'button' && textOf(node).includes('更新列表'))[0]
  update.props.onClick()
  await flush()
  assert.deepEqual([...patches.at(-1).visibleModels], ['gemini-4-argon'])
  view.unmount()
})

test('the settings tab renders the same provider block as the Models card', async () => {
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: { status: async () => catalogStatus([]) },
  })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()
  assert.match(textOf(view.tree), /全部 2 个模型/, 'the tab shows the provider allowlist too')
  view.unmount()
})

test('an account block narrows the provider catalog and writes its own subset', async () => {
  const patches = []
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => catalogStatus(['claude-opus-5-5']),
      warmup: async () => catalogStatus(['claude-opus-5-5']),
      configure: async (patch) => {
        patches.push(patch)
        return catalogStatus(['claude-opus-5-5'])
      },
    },
  })
  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()
  // The account row renders its own block inside the editor; open it first.
  const edit = findAll(view.tree, (node) => node.tag === 'button' && textOf(node) === '编辑')[0]
  if (edit !== undefined) {
    edit.props.onClick()
    await flush()
  }
  const blocks = findAll(view.tree, (node) => String(node.props && node.props['aria-label'] || '').includes('账号调度模型'))
  assert.ok(blocks.length > 0, 'the account editor mounts an account-level routable models block')
  // Account-level model list reuses the exact same row-list + × remove + Fetch models picker UI as provider-level.
  const rowCodes = findAll(blocks[0], (node) => node.tag === 'code' && String(node.props.className || '').includes('dsh-modelselection-id'))
  assert.deepEqual(rowCodes.map(textOf), ['claude-opus-5-5'], 'only globally enabled models appear in the account model list')
  assert.match(textOf(blocks[0]), /全局已关闭.*gemini-4-argon/, 'globally disabled models are explained inline')
  const fetchBtn = findAll(blocks[0], (node) => node.tag === 'button' && textOf(node).includes('获取可用模型'))[0]
  assert.ok(fetchBtn, 'account model block reuses the same Fetch models button')
  const dialogsBefore = findAll(view.tree, (node) => node.props && node.props.role === 'dialog').length
  fetchBtn.props.onClick()
  await flush()
  const dialogsAfter = findAll(view.tree, (node) => node.props && node.props.role === 'dialog').length
  assert.equal(dialogsAfter, dialogsBefore + 1, 'Fetch models opens the unified Select models checkbox dialog')
  view.unmount()
})

test('settings.models.provider-card stays collapsed when open is false and expands when open is true', async () => {
  let statusCalls = 0
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => {
        statusCalls += 1
        return catalogStatus([])
      },
    },
  })
  const slot = registered.get('settings.models.provider-card')
  await flush()
  statusCalls = 0
  const collapsed = mount(slot.Component, {
    ...slot.meta.inject(),
    provider: { provider: 'antigravity', displayName: 'Antigravity', settingsNs: 'llm-antigravity-acp', settingsPath: [] },
    configured: true,
    keyConfigured: false,
    open: false,
  })
  await flush()
  assert.equal(collapsed.tree, null, 'collapsed row card renders nothing outside rowHead')
  assert.equal(statusCalls, 0, 'collapsed row card avoids eager status RPCs')
  collapsed.unmount()

  const expanded = mount(slot.Component, {
    ...slot.meta.inject(),
    provider: { provider: 'antigravity', displayName: 'Antigravity', settingsNs: 'llm-antigravity-acp', settingsPath: [] },
    configured: true,
    keyConfigured: false,
    open: true,
  })
  await flush()
  assert.match(textOf(expanded.tree), /全部 2 个模型/)
  assert.equal(statusCalls, 1)
  expanded.unmount()
})

test('AccountsPanel renders ULTRA and PRO badges, per-account entitled models, and Pro independent Argon weekly quota', async () => {
  const mixedStatus = {
    state: 'ready',
    version: '1.5.3',
    contextWindow: 1_048_576,
    configuredContextWindow: 0,
    defaultEffort: 'high',
    longDecodeContinuations: 3,
    models: [
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
    ],
    availableModels: [
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', enabled: true },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', enabled: true },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', enabled: true },
      { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', enabled: true },
    ],
    visibleModels: [],
    accounts: [
      {
        id: 'default',
        label: 'This Mac',
        system: true,
        enabled: true,
        state: 'ready',
        sessions: 0,
        email: 'ultra@example.com',
        subscriptionTier: 'ULTRA',
        subscriptionName: 'Google AI Ultra',
        availableModels: [
          { id: 'gemini-4-argon', name: 'Gemini 4 Argon', enabled: true },
          { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', enabled: true },
          { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', enabled: true },
        ],
        visibleModels: [],
      },
      {
        id: 'acc-student',
        label: '',
        system: false,
        enabled: true,
        state: 'idle',
        sessions: 0,
        email: 'student@example.edu',
        subscriptionTier: 'PRO',
        subscriptionName: 'Google AI Pro',
        availableModels: [
          { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', enabled: true },
          { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', enabled: true },
        ],
        disabledModels: ['gemini-4-argon'],
        visibleModels: [],
      },
    ],
  }

  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => mixedStatus,
      accounts: async () => mixedStatus.accounts,
      quota: async (req) => {
        if (req?.accountId === 'acc-student') {
          return {
            status: 'ok',
            subscriptionTier: 'PRO',
            subscriptionName: 'Google AI Pro',
            disabledModels: ['gemini-4-argon'],
            groups: [
              { kind: 'gemini', name: 'Gemini 3.8 Flash', buckets: [{ id: 'gemini-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-14T00:00:00Z' }] },
              { kind: 'argon', name: 'Gemini 4 Argon', buckets: [{ id: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-11-14T00:00:00Z' }] },
              { kind: 'claude', name: 'Claude 4.6 / GPT', buckets: [{ id: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-14T00:00:00Z' }] },
            ],
          }
        }
        return {
          status: 'ok',
          subscriptionTier: 'ULTRA',
          subscriptionName: 'Google AI Ultra',
          groups: [
            { kind: 'gemini', name: 'Gemini 4 Argon / 3.8', buckets: [{ id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.82, resetTime: '2026-11-14T00:00:00Z' }] },
          ],
        }
      },
    },
  })

  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  const cards = findAll(view.tree, (n) => n.props && 'data-agy-account' in n.props)
  assert.equal(findOne(cards[0], (n) => n.props && n.props['data-agy-tier'] === 'ULTRA') !== undefined, true)
  assert.equal(findOne(cards[1], (n) => n.props && n.props['data-agy-tier'] === 'PRO') !== undefined, true)

  // Expand Pro account quota drawer -> sees independent Argon weekly row + Google AI Pro header.
  const proQuotaBtn = findAll(cards[1], (n) => n.tag === 'button' && textOf(n) === '额度')[0]
  proQuotaBtn.props.onClick()
  await flush()
  const updatedCards = findAll(view.tree, (n) => n.props && 'data-agy-account' in n.props)
  const proText = textOf(updatedCards[1])
  assert.match(proText, /Google AI Pro/)
  assert.match(proText, /Gemini 4 Argon（独立周限）/)
  assert.match(proText, /42%/)
  assert.match(proText, /Claude 4\.6 \/ GPT 额度/)

  // Open Pro account editor -> opens in a popup Modal (not inline inside the card!), with Priority/Weight steppers and only its own 2 models!
  const proEditBtn = findAll(updatedCards[1], (n) => n.tag === 'button' && textOf(n) === '编辑')[0]
  proEditBtn.props.onClick()
  await flush()
  const editedCards = findAll(view.tree, (n) => n.props && 'data-agy-account' in n.props)
  assert.equal(findOne(editedCards[1], (n) => n.tag === 'input' && n.props['aria-label'] === '代理'), null, 'editor does not pile inline inside the account card')
  const editorModal = findOne(view.tree, (n) => n.props && n.props['data-agy-editor-modal'] === 'acc-student')
  assert.ok(editorModal, 'clicking 编辑 opens the popup account editor modal')
  assert.ok(findOne(editorModal, (n) => n.props && n.props['aria-label'] === '优先级'))
  assert.ok(findOne(editorModal, (n) => n.props && n.props['aria-label'] === '权重'))
  const subsetBlock = findAll(editorModal, (n) => String(n.props && n.props['aria-label'] || '').includes('账号调度模型'))[0]
  const subsetText = textOf(subsetBlock)
  assert.match(subsetText, /全部 2 个模型/)
  assert.match(subsetText, /获取可用模型/)
  assert.match(subsetText, /gemini-3\.8-flash/)
  assert.match(subsetText, /claude-opus-4-6-thinking/)
  assert.doesNotMatch(subsetText, /claude-opus-5-5/, 'student/Jio Pro account does not list unentitled Claude 5.5')
  assert.doesNotMatch(subsetText, /gemini-4-argon/, 'student/Jio Pro account does not list disabled Argon')

  view.unmount()
})

test('QuotaPill displays session-scoped degraded diagnostic signals and auto-healed gatekeeper notice on Argon only', async () => {
  const statusPayload = () => ({
    state: 'ready',
    version: '1.5.3',
    contextWindow: 1_048_576,
    configuredContextWindow: 0,
    defaultEffort: 'high',
    longDecodeContinuations: 3,
    sessionHealth: {
      'session-degraded': {
        sessionId: 'session-degraded',
        acpSessionId: 'acp-912c34',
        model: 'gemini-4-argon',
        degraded: true,
        score: 9,
        signals: [
          { kind: 'context_truncated', points: 5, detail: '378K→128K', cwmEstTokens: 378421 },
          { kind: 'cache_cliff', points: 4, detail: '-20.7K', droppedTokens: 20735 },
        ],
        streamTps: 420,
        wallTps: 310,
        ttftSeconds: 2.3,
        thoughtTokens: 0,
        contextTokens: 127997,
        consecutiveDegradedTurns: 1,
        interceptedSteps: 0,
        hasHealthyArgonCache: false,
        updatedAt: new Date(FIXED_NOW).toISOString(),
      },
      'session-healed': {
        sessionId: 'session-healed',
        acpSessionId: 'acp-healed',
        model: 'gemini-4-argon',
        degraded: false,
        score: 0,
        signals: [],
        streamTps: 48,
        wallTps: 41,
        ttftSeconds: 11.4,
        thoughtTokens: 920,
        contextTokens: 310000,
        consecutiveDegradedTurns: 0,
        interceptedSteps: 2,
        hasHealthyArgonCache: true,
        updatedAt: new Date(FIXED_NOW).toISOString(),
      },
    },
  })

  const { registered, mount, store } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => statusPayload(),
      quota: async () => ({
        status: 'ok',
        updatedAt: new Date(FIXED_NOW).toISOString(),
        groups: [{
          name: 'Gemini Models',
          description: '',
          buckets: [{ id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.9, resetTime: isoAfterHours(60) }],
        }],
      }),
    },
  })

  assert.equal(registered.get('conversation.chat.turnTail'), undefined, 'destructive turnTail bloat is gone')
  const slot = registered.get('conversation.input.right')

  // Healthy auto-healed session shows calm pill on top bar and gatekeeper summary inside popover.
  const healedView = mount(slot.Component, slot.meta.inject('session-healed'))
  await flush()
  const healedBtn = findOne(healedView.tree, (n) => n.tag === 'button')
  assert.equal(textOf(healedBtn), '周 90%')
  assert.equal(findOne(healedView.tree, (n) => n.props && n.props['data-agy-degraded'] === 'true'), null)
  healedBtn.props.onClick()
  await flush()
  const healedNote = findOne(healedView.tree, (n) => n.props && n.props['data-agy-gatekeeper-healed'] === '2')
  assert.ok(healedNote)
  assert.match(textOf(healedNote), /本会话已自动重答 2 次/)
  healedView.unmount()

  // Degraded Argon text-only session displays compact 降智 chip and read-only diagnostic card.
  const degradedView = mount(slot.Component, slot.meta.inject('session-degraded'))
  await flush()
  const pillBtn = findOne(degradedView.tree, (n) => n.tag === 'button')
  assert.equal(textOf(pillBtn), '周 90%降智')
  assert.match(pillBtn.props.title, /可能降智/)

  pillBtn.props.onClick()
  await flush()
  const card = findOne(degradedView.tree, (n) => n.props && n.props['data-agy-degrade-card'] === 'true')
  assert.ok(card, 'popover should render the route diagnostic card')
  assert.match(textOf(card), /这条回答可能降智了/)
  assert.doesNotMatch(textOf(card), /指纹 9 分/)
  assert.match(textOf(card), /上下文被截到 128K（原 378K）/)
  assert.match(textOf(card), /上下文少了 20\.7K/)
  assert.doesNotMatch(textOf(card), /已保留热会话避免重放失忆/)

  // Switching away from Argon (e.g. to Claude) hides the Argon route warning immediately.
  store.setCurrent({ provider: 'antigravity', model: 'claude-opus-5-5' })
  await flush()
  assert.equal(findOne(degradedView.tree, (n) => n.props && n.props['data-agy-degraded'] === 'true'), null)
  assert.equal(findOne(degradedView.tree, (n) => n.props && n.props['data-agy-degrade-card'] === 'true'), null)

  degradedView.unmount()
})

test('QuotaPill shows live route health and auto re-answer counts on Gemini 4 Carbon too', async () => {
  const carbonHealth = (extra) => ({
    acpSessionId: 'acp-carbon',
    model: 'gemini-4-carbon',
    streamTps: 410,
    wallTps: 300,
    ttftSeconds: 2.1,
    thoughtTokens: 0,
    contextTokens: 127997,
    consecutiveDegradedTurns: 1,
    hasHealthyArgonCache: false,
    updatedAt: new Date(FIXED_NOW).toISOString(),
    ...extra,
  })
  const { registered, mount, store } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => ({
        state: 'ready',
        version: '1.5.5',
        contextWindow: 1_048_576,
        configuredContextWindow: 0,
        defaultEffort: 'high',
        longDecodeContinuations: 3,
        degradeAction: 'truncation',
        sessionHealth: {
          'carbon-degraded': carbonHealth({
            sessionId: 'carbon-degraded',
            degraded: true,
            score: 5,
            signals: [{ kind: 'context_truncated', points: 5, detail: '378K→128K', cwmEstTokens: 378421 }],
            interceptedSteps: 0,
          }),
          'carbon-healed': carbonHealth({
            sessionId: 'carbon-healed',
            degraded: false,
            score: 0,
            signals: [],
            consecutiveDegradedTurns: 0,
            interceptedSteps: 3,
          }),
        },
      }),
      quota: async () => ({
        status: 'ok',
        updatedAt: new Date(FIXED_NOW).toISOString(),
        groups: [{
          name: 'Gemini Models',
          description: '',
          buckets: [{ id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.8, resetTime: isoAfterHours(60) }],
        }],
      }),
    },
  })
  store.setCurrent({ provider: 'antigravity', model: 'gemini-4-carbon' })
  const slot = registered.get('conversation.input.right')

  const degradedView = mount(slot.Component, slot.meta.inject('carbon-degraded'))
  await flush()
  const pillBtn = findOne(degradedView.tree, (n) => n.tag === 'button')
  assert.match(textOf(pillBtn), /降智$/, 'a degraded Carbon session carries the warning chip')
  assert.match(pillBtn.props.title, /可能降智/)
  pillBtn.props.onClick()
  await flush()
  const card = findOne(degradedView.tree, (n) => n.props && n.props['data-agy-degrade-card'] === 'true')
  assert.ok(card, 'the Carbon popover renders the route diagnostic card')
  assert.match(textOf(card), /上下文被截到 128K（原 378K）/)
  degradedView.unmount()

  const healedView = mount(slot.Component, slot.meta.inject('carbon-healed'))
  await flush()
  const healedBtn = findOne(healedView.tree, (n) => n.tag === 'button')
  assert.equal(findOne(healedView.tree, (n) => n.props && n.props['data-agy-degraded'] === 'true'), null)
  healedBtn.props.onClick()
  await flush()
  const healedNote = findOne(healedView.tree, (n) => n.props && n.props['data-agy-gatekeeper-healed'] === '3')
  assert.ok(healedNote, 'the Carbon drawer reports its intercepted count')
  assert.match(textOf(healedNote), /本会话已自动重答 3 次/)

  // A non-flagship model hides the route state again.
  store.setCurrent({ provider: 'antigravity', model: 'gemini-3.8-flash' })
  await flush()
  assert.equal(findOne(healedView.tree, (n) => n.props && n.props['data-agy-gatekeeper-healed'] !== undefined), null)
  healedView.unmount()
})

test('QuotaPill reports an unentitled model instead of another family’s 100%', async () => {
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      quota: async () => ({
        status: 'ok',
        model: 'gemini-4-argon',
        accountId: 'acc-pro',
        accountLabel: 'pro@example.com',
        subscriptionTier: 'PRO',
        subscriptionName: 'Google AI Pro',
        disabledModels: ['gemini-4-argon'],
        availableModels: [
          { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
          { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
        ],
        groups: [
          { kind: 'gemini', name: 'Gemini 3.8 Flash', buckets: [{ id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remainingFraction: 1, resetTime: isoAfterHours(120) }] },
          { kind: 'claude', name: 'Claude 4.6 / GPT', buckets: [{ id: '3p-weekly', name: 'Weekly', window: 'weekly', remainingFraction: 1, resetTime: isoAfterHours(120) }] },
        ],
      }),
    },
  })

  const slot = registered.get('conversation.input.right')
  const view = mount(slot.Component, slot.meta.inject('session-pro'))
  await flush()

  const btn = findOne(view.tree, (n) => n.tag === 'button')
  assert.equal(textOf(btn), 'Argon 未开通')
  assert.equal(btn.props['data-agy-quota-entitled'], 'false')
  assert.equal(btn.props['data-agy-quota-account'], 'pro@example.com')
  assert.doesNotMatch(btn.props.title, /100%/, 'the Pro plan’s untouched Gemini pool is never shown as Argon capacity')
  assert.match(btn.props.title, /未包含在当前账号的订阅中/)
  assert.match(btn.props.title, /pro@example\.com/)

  btn.props.onClick()
  await flush()
  const dialog = findOne(view.tree, (n) => n.props && n.props.role === 'dialog')
  assert.ok(dialog, 'the popover opens on the unentitled state too')
  const text = textOf(dialog)
  assert.match(text, /未包含在此账号的订阅中/)
  assert.match(text, /Google AI Pro/)
  assert.match(text, /pro@example\.com/, 'the number always names the account behind it')
  assert.doesNotMatch(text, /每周额度/, 'no window card is drawn for a model this account cannot spend')
  assert.doesNotMatch(text, /100%/)
  view.unmount()
})

test('QuotaPill asks about the model on screen and drops a late answer for the previous one', async () => {
  const requests = []
  const pending = []
  const { registered, mount, store } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      quota: (request) => {
        requests.push(request)
        return new Promise((resolve) => { pending.push({ request, resolve }) })
      },
    },
  })

  const slot = registered.get('conversation.input.right')
  const view = mount(slot.Component, slot.meta.inject('session-switch'))
  await flush()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'gemini-4-argon', 'the pill asks by model, never by "whoever ran last"')
  assert.equal(requests[0].force, false)
  assert.equal(textOf(findOne(view.tree, (n) => n.tag === 'button')), '周 …')

  // Switch model before the first answer lands: the old number must be cleared
  // and the read re-issued for the new model.
  store.setCurrent({ provider: 'antigravity', model: 'claude-opus-5-5' })
  await flush()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].model, 'claude-opus-5-5')
  assert.equal(requests[1].force, false)
  assert.equal(textOf(findOne(view.tree, (n) => n.tag === 'button')), '周 …')

  pending[1].resolve({
    status: 'ok',
    model: 'claude-opus-5-5',
    accountId: 'acc-ultra',
    groups: [{ kind: 'claude', name: 'Claude and GPT models', buckets: [{ id: 'claude_weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.46, resetTime: isoAfterHours(100) }] }],
  })
  await flush()
  assert.equal(textOf(findOne(view.tree, (n) => n.tag === 'button')), '周 46%')

  // The late Argon answer is stale and must never overwrite the Claude pill.
  pending[0].resolve({
    status: 'ok',
    model: 'gemini-4-argon',
    accountId: 'acc-ultra',
    groups: [{ kind: 'gemini', name: 'Gemini 4 Argon / 3.8', buckets: [{ id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.98, resetTime: isoAfterHours(50) }] }],
  })
  await flush()
  assert.equal(textOf(findOne(view.tree, (n) => n.tag === 'button')), '周 46%', 'a stale answer never repaints the current model')
  view.unmount()
})

test('Windows AccountsPanel shows single-active toolbar, hot-switch button, snapshot backup, and credential import', async () => {
  const calls = []
  let activeId = 'default'
  const makeStatus = () => ({
    state: 'ready',
    version: '1.2.3',
    platform: 'win32',
    activeAccountId: activeId,
    contextWindow: 1_048_576,
    configuredContextWindow: 0,
    defaultEffort: 'high',
    longDecodeContinuations: 3,
    degradeAction: 'truncation',
    engineMode: 'bridge',
    models: [],
    availableModels: [],
    visibleModels: [],
    accounts: [
      {
        id: 'default', label: 'This Mac', system: true, enabled: true, active: activeId === 'default',
        hasRefreshToken: true, state: 'ready', sessions: 1, email: 'alice@example.com', subscriptionTier: 'PRO',
        env: {}, home: '', contextWindow: 0, visibleModels: [], priority: 1, weight: 1, cooldowns: [],
      },
      {
        id: 'acc-bob', label: 'Bob Ultra', system: false, enabled: true, active: activeId === 'acc-bob',
        hasRefreshToken: true, state: 'idle', sessions: 0, email: 'bob@example.com', subscriptionTier: 'ULTRA',
        env: {}, home: '', contextWindow: 0, visibleModels: [], priority: 1, weight: 1, cooldowns: [],
      },
    ],
  })

  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => makeStatus(),
      accounts: async () => makeStatus().accounts,
      switchAccount: async (req) => {
        calls.push({ method: 'switchAccount', req })
        activeId = req.accountId
        return makeStatus()
      },
      snapshotAccount: async (req) => {
        calls.push({ method: 'snapshotAccount', req })
        return { accountId: 'default', email: 'alice@example.com', created: false, hasRefreshToken: true, status: makeStatus() }
      },
      importCredential: async (req) => {
        calls.push({ method: 'importCredential', req })
        return { accountId: 'acc-carol', email: 'carol@example.com', created: true, hasRefreshToken: true, status: makeStatus() }
      },
    },
  })

  const section = registered.get('settings.section')
  const view = mount(section.Component, section.meta.inject())
  await flush()

  // Windows toolbar + Active badge on default + Switch button only on inactive Bob
  assert.ok(findOne(view.tree, (n) => n.props && n.props['data-agy-win-toolbar'] === 'true'))
  const defaultCard = findOne(view.tree, (n) => n.props && n.props['data-agy-account'] === 'default')
  assert.equal(defaultCard.props['data-agy-active'], 'true')
  assert.ok(findOne(defaultCard, (n) => n.props && n.props['data-agy-active-badge'] === 'true'))
  assert.equal(findOne(defaultCard, (n) => n.props && n.props['data-agy-switch-btn'] === 'default'), null)

  const switchBobBtn = findOne(view.tree, (n) => n.props && n.props['data-agy-switch-btn'] === 'acc-bob')
  assert.ok(switchBobBtn, 'inactive signed-in Windows backup account exposes Switch button')
  switchBobBtn.props.onClick()
  await flush()
  assert.equal(calls[0].method, 'switchAccount')
  assert.equal(calls[0].req.accountId, 'acc-bob')
  const bobCardAfter = findOne(view.tree, (n) => n.props && n.props['data-agy-account'] === 'acc-bob')
  assert.equal(bobCardAfter.props['data-agy-active'], 'true')

  // Snapshot current login
  const snapshotBtn = findOne(view.tree, (n) => n.props && n.props['data-agy-snapshot-btn'] === 'true')
  snapshotBtn.props.onClick()
  await flush()
  assert.equal(calls[1].method, 'snapshotAccount')

  // Open import backup drawer and submit credential payload
  const importToggle = findOne(view.tree, (n) => n.props && n.props['data-agy-import-toggle'] === 'true')
  importToggle.props.onClick()
  await flush()
  const importBox = findOne(view.tree, (n) => n.props && n.props['data-agy-import-box'] === 'true')
  assert.ok(importBox)
  const textarea = findOne(importBox, (n) => n.tag === 'textarea')
  textarea.props.onChange({ target: { value: 'C:\\backups\\carol.json' } })
  await flush()
  const submitBtn = findOne(view.tree, (n) => n.props && n.props['data-agy-import-submit'] === 'true')
  submitBtn.props.onClick()
  await flush()
  assert.equal(calls[2].method, 'importCredential')
  assert.equal(calls[2].req.content, 'C:\\backups\\carol.json')
  assert.equal(findOne(view.tree, (n) => n.props && n.props['data-agy-import-box'] === 'true'), null, 'import box closes after success')
  view.unmount()
})

test('AccountCard surfaces verification, ToS suspension, and downgrade banners with recheck and dismiss actions', async () => {
  let verifyRequired = true
  let hasDowngrade = true
  const calls = []
  const makeStatus = () => ({
    state: 'ready',
    version: '1.2.3',
    platform: 'win32',
    activeAccountId: 'acc-verify',
    contextWindow: 1_048_576,
    configuredContextWindow: 0,
    defaultEffort: 'high',
    longDecodeContinuations: 3,
    degradeAction: 'truncation',
    engineMode: 'bridge',
    models: [],
    availableModels: [],
    visibleModels: [],
    accounts: [
      {
        id: 'acc-verify', label: 'Verify Me', system: false, enabled: true, active: true,
        state: 'ready', sessions: 0, email: 'verify@example.com', subscriptionTier: 'FREE',
        verificationRequired: verifyRequired,
        verificationUrl: 'https://accounts.google.com/verify-me',
        downgradeAlert: hasDowngrade ? {
          fromTier: 'PRO', toTier: 'FREE', fromModels: 5, toModels: 2,
          detectedAt: '2026-11-22T00:00:00.000Z', acknowledged: false,
        } : undefined,
        tierHistory: [
          { tier: 'PRO', modelCount: 5, at: '2026-11-20T00:00:00.000Z' },
          { tier: 'FREE', modelCount: 2, at: '2026-11-22T00:00:00.000Z' },
        ],
        env: {}, home: '', contextWindow: 0, visibleModels: [], priority: 1, weight: 1, cooldowns: [],
      },
      {
        id: 'acc-tos', label: 'Suspended One', system: false, enabled: true, active: false,
        state: 'idle', sessions: 0, email: 'tos@example.com',
        tosSuspended: true,
        tosAppealUrl: 'https://forms.gle/hGzM9MEUv2azZsrb9',
        env: {}, home: '', contextWindow: 0, visibleModels: [], priority: 1, weight: 1, cooldowns: [],
      },
    ],
  })

  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => makeStatus(),
      accounts: async () => makeStatus().accounts,
      recheckAccount: async (req) => {
        calls.push({ method: 'recheckAccount', req })
        if (req.accountId === 'acc-verify') verifyRequired = false
        return { status: makeStatus(), quota: { status: 'ok', groups: [] } }
      },
      ackDowngrade: async (req) => {
        calls.push({ method: 'ackDowngrade', req })
        hasDowngrade = false
        return makeStatus()
      },
    },
  })

  const section = registered.get('settings.section')
  const view = mount(section.Component, section.meta.inject())
  await flush()

  // Verification link + Downgrade banner + ToS appeal link all render
  const verifyLink = findOne(view.tree, (n) => n.props && n.props['data-agy-verify-link'] === 'acc-verify')
  assert.equal(verifyLink.props.href, 'https://accounts.google.com/verify-me')
  const tosLink = findOne(view.tree, (n) => n.props && n.props['data-agy-tos-appeal-link'] === 'acc-tos')
  assert.equal(tosLink.props.href, 'https://forms.gle/hGzM9MEUv2azZsrb9')
  assert.ok(findOne(view.tree, (n) => n.props && n.props['data-agy-health-banner'] === 'downgrade'))

  // Click Recheck on verification banner -> clears verificationRequired
  const recheckBtn = findOne(view.tree, (n) => n.props && n.props['data-agy-recheck-btn'] === 'acc-verify')
  recheckBtn.props.onClick()
  await flush()
  assert.equal(calls[0].method, 'recheckAccount')
  assert.equal(calls[0].req.accountId, 'acc-verify')
  assert.equal(findOne(view.tree, (n) => n.props && n.props['data-agy-health-banner'] === 'verification'), null)

  // Click Dismiss on downgrade banner -> hides banner
  const ackBtn = findOne(view.tree, (n) => n.props && n.props['data-agy-ack-downgrade-btn'] === 'acc-verify')
  ackBtn.props.onClick()
  await flush()
  assert.equal(calls[1].method, 'ackDowngrade')
  assert.equal(calls[1].req.accountId, 'acc-verify')
  assert.equal(findOne(view.tree, (n) => n.props && n.props['data-agy-health-banner'] === 'downgrade'), null)

  // Open Edit modal -> tier history remains visible
  const verifyCard = findOne(view.tree, (n) => n.props && n.props['data-agy-account'] === 'acc-verify')
  const editBtn = findOne(verifyCard, (n) => n.tag === 'button' && textOf(n) === '编辑')
  editBtn.props.onClick()
  await flush()
  const historyBlock = findOne(view.tree, (n) => n.props && n.props['data-agy-tier-history'] === 'acc-verify')
  assert.ok(historyBlock)
  assert.match(textOf(historyBlock), /PRO \(5\)/)
  assert.match(textOf(historyBlock), /FREE \(2\)/)
  view.unmount()
})

test('QuotaPill surfaces verification, ToS suspension, and downgrade alerts on pill and popover', async () => {
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      quota: async () => ({
        status: 'error',
        model: 'gemini-4-argon',
        accountId: 'default',
        accountLabel: 'alice@example.com',
        error: 'Verify your account to continue.',
        verificationRequired: true,
        verificationUrl: 'https://accounts.google.com/verify-pill',
        downgradeAlert: {
          fromTier: 'PRO', toTier: 'FREE', fromModels: 5, toModels: 2,
          detectedAt: '2026-11-22T00:00:00.000Z', acknowledged: false,
        },
        groups: [],
      }),
    },
  })

  const slot = registered.get('conversation.input.right')
  const view = mount(slot.Component, slot.meta.inject('session-verify'))
  await flush()

  const btn = findOne(view.tree, (n) => n.tag === 'button')
  assert.ok(findOne(btn, (n) => n.props && n.props['data-agy-pill-verify'] === 'true'))
  btn.props.onClick()
  await flush()

  const dialog = findOne(view.tree, (n) => n.props && n.props.role === 'dialog')
  assert.ok(findOne(dialog, (n) => n.props && n.props['data-agy-popover-verify'] === 'true'))
  assert.ok(findOne(dialog, (n) => n.props && n.props['data-agy-popover-downgrade'] === 'true'))
  const link = findOne(dialog, (n) => n.tag === 'a')
  assert.equal(link.props.href, 'https://accounts.google.com/verify-pill')
  view.unmount()
})

test('QuotaPill renders per-session account switcher in popover, displays pill account chip, switches session in one click, and supports Auto unpin', async () => {
  const calls = []
  let pinned = {}
  const makeAccounts = () => [
    {
      id: 'default', label: '主力Pro', system: true, enabled: true, state: 'ready',
      email: 'alice@example.com', subscriptionTier: 'PRO', subscriptionName: 'Google AI Pro',
      hasRefreshToken: true, quotaSummary: { gemini: 0.15, primary: 0.15 },
    },
    {
      id: 'acc-bob', label: 'Ultra号', system: false, enabled: true, state: 'ready',
      email: 'bob@example.com', subscriptionTier: 'ULTRA', subscriptionName: 'Google AI Ultra',
      hasRefreshToken: true, quotaSummary: { gemini: 0.94, argon: 0.94, primary: 0.94 },
    },
  ]
  const currentStatus = () => ({
    state: 'ready',
    platform: 'win32',
    multiAccountMode: 'concurrent',
    activeAccountId: 'default',
    pinnedSessions: { ...pinned },
    sessionAccounts: { 'sess-dev-1': pinned['sess-dev-1'] || 'default' },
    accounts: makeAccounts(),
  })
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: () => currentStatus(),
      quota: async (req) => {
        const sid = req && req.sessionId
        const accId = (sid && pinned[sid]) || 'default'
        if (accId === 'acc-bob') {
          return {
            status: 'ok',
            model: req.model,
            accountId: 'acc-bob',
            accountLabel: 'Ultra号',
            subscriptionTier: 'ULTRA',
            subscriptionName: 'Google AI Ultra',
            updatedAt: new Date(FIXED_NOW).toISOString(),
            groups: [{
              kind: 'gemini', name: 'Gemini Models', description: '',
              buckets: [{ id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.94, resetTime: isoAfterHours(60) }],
            }],
          }
        }
        return {
          status: 'ok',
          model: req.model,
          accountId: 'default',
          accountLabel: '主力Pro',
          subscriptionTier: 'PRO',
          subscriptionName: 'Google AI Pro',
          updatedAt: new Date(FIXED_NOW).toISOString(),
          groups: [{
            kind: 'gemini', name: 'Gemini Models', description: '',
            buckets: [{ id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.15, resetTime: isoAfterHours(24) }],
          }],
        }
      },
      switchAccount: async (req) => {
        calls.push(req)
        if (req.clear === true && req.sessionId) {
          delete pinned[req.sessionId]
        } else if (req.sessionId && req.accountId) {
          pinned[req.sessionId] = req.accountId
        }
        return currentStatus()
      },
    },
  })

  const slot = registered.get('conversation.input.right')
  const view = mount(slot.Component, slot.meta.inject('sess-dev-1'))
  await flush()

  // Collapsed pill displays the account chip in multi-account mode
  const pillBtn = findOne(view.tree, (n) => n.tag === 'button')
  const chip = findOne(pillBtn, (n) => n.props && n.props['data-agy-pill-account-chip'] === 'true')
  assert.ok(chip, 'multi-account pill shows current session account chip')
  assert.equal(textOf(chip), '主力Pro')

  // Open popover and verify per-session account switcher lists both accounts with % and tiers
  pillBtn.props.onClick()
  await flush()
  const switcher = findOne(view.tree, (n) => n.props && n.props['data-agy-session-switcher'] === 'true')
  assert.ok(switcher, 'popover renders per-session account switcher')
  const aliceRow = findOne(switcher, (n) => n.props && n.props['data-agy-pill-switch-account'] === 'default')
  const bobRow = findOne(switcher, (n) => n.props && n.props['data-agy-pill-switch-account'] === 'acc-bob')
  assert.equal(aliceRow.props['data-agy-pill-account-selected'], 'true')
  assert.equal(bobRow.props['data-agy-pill-account-selected'], 'false')
  assert.match(textOf(bobRow), /Ultra号.*ULTRA.*94%/)

  // One-click switch this session to Bob
  bobRow.props.onClick()
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].accountId, 'acc-bob')
  assert.equal(calls[0].sessionId, 'sess-dev-1')

  // Pill chip and popover quota bars update immediately to Bob (94%) and show Auto unpin button
  const chipAfter = findOne(view.tree, (n) => n.props && n.props['data-agy-pill-account-chip'] === 'true')
  assert.equal(textOf(chipAfter), 'Ultra号')
  const bobRowAfter = findOne(view.tree, (n) => n.props && n.props['data-agy-pill-switch-account'] === 'acc-bob')
  assert.equal(bobRowAfter.props['data-agy-pill-account-selected'], 'true')
  const unpinBtn = findOne(view.tree, (n) => n.props && n.props['data-agy-session-unpin'] === 'true')
  assert.ok(unpinBtn, 'pinned session offers Auto unpin control')

  // Click Auto to return session to automatic scheduling
  unpinBtn.props.onClick()
  await flush()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].sessionId, 'sess-dev-1')
  assert.equal(calls[1].clear, true)
  assert.equal(findOne(view.tree, (n) => n.props && n.props['data-agy-session-unpin'] === 'true'), null)

  view.unmount()
})

test('QuotaPill localizes This Mac to 本机 and renders the session account panel with guidance even when only 1 account is configured', async () => {
  const { registered, mount, store } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: () => ({
        state: 'ready',
        platform: 'win32',
        multiAccountMode: 'concurrent',
        activeAccountId: 'default',
        accounts: [{
          id: 'default', label: 'This Mac', system: true, enabled: true, state: 'ready',
          email: 'alice@example.com', subscriptionTier: 'PRO', subscriptionName: 'Google AI Pro',
          hasRefreshToken: true, quotaSummary: { gemini: 0.72, primary: 0.72 },
        }],
      }),
      quota: async (req) => ({
        status: 'ok',
        model: req.model,
        accountId: 'default',
        accountLabel: 'This Mac',
        subscriptionTier: 'PRO',
        subscriptionName: 'Google AI Pro',
        updatedAt: new Date(FIXED_NOW).toISOString(),
        groups: [{
          kind: 'gemini', name: 'Gemini Models', description: '',
          buckets: [{ id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.72, resetTime: isoAfterHours(60) }],
        }],
      }),
      switchAccount: async () => ({}),
    },
  })
  store.setCurrent({ provider: 'antigravity', model: 'gemini-4-neon' })

  const slot = registered.get('conversation.input.right')
  const view = mount(slot.Component, slot.meta.inject('sess-single'))
  await flush()

  const pillBtn = findOne(view.tree, (n) => n.tag === 'button')
  assert.equal(pillBtn.props['data-agy-quota-account'], '本机')
  assert.equal(findOne(pillBtn, (n) => n.props && n.props['data-agy-pill-account-chip'] === 'true'), null, 'single-account pill stays compact without chip')

  pillBtn.props.onClick()
  await flush()

  const switcher = findOne(view.tree, (n) => n.props && n.props['data-agy-session-switcher'] === 'true')
  assert.ok(switcher, 'popover shows session account section even with 1 account')
  assert.ok(!textOf(switcher).includes('This Mac'), 'popover must not leak raw This Mac label on zh-CN')
  assert.match(textOf(switcher), /本机.*alice@example\.com.*PRO.*72%/)
  assert.ok(findOne(switcher, (n) => n.props && n.props['data-agy-single-account-hint'] === 'true'))
  view.unmount()
})

test('D3 UI: QuotaPill displays route-health degrade card on Neon and Hydrogen, and hides it on Orchestrator', async () => {
  const healthEntry = (model) => ({
    sessionId: 'sess-flagship',
    acpSessionId: 'acp-1',
    model,
    degraded: true,
    score: 5,
    signals: [{ kind: 'context_truncated', points: 5, detail: '320K→128K' }],
    streamTps: 90,
    wallTps: 60,
    ttftSeconds: 3.1,
    thoughtTokens: 15,
    contextTokens: 127_997,
    consecutiveDegradedTurns: 1,
    interceptedSteps: 0,
    hasHealthyArgonCache: false,
    updatedAt: new Date(FIXED_NOW).toISOString(),
  })

  const { registered, mount, store } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: () => ({
        state: 'ready',
        degradeAction: 'truncation',
        sessionHealth: { 'sess-flagship': healthEntry('gemini-4-neon') },
      }),
      quota: async (req) => ({
        status: 'ok',
        model: req.model,
        accountId: 'default',
        accountLabel: 'This Mac',
        updatedAt: new Date(FIXED_NOW).toISOString(),
        groups: [{ kind: 'gemini', name: 'Gemini', description: '', buckets: [{ id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.8, resetTime: isoAfterHours(48) }] }],
      }),
    },
  })

  const slot = registered.get('conversation.input.right')

  // Neon -> shows degrade chip and card
  store.setCurrent({ provider: 'antigravity', model: 'gemini-4-neon' })
  const view = mount(slot.Component, slot.meta.inject('sess-flagship'))
  await flush()
  let pillBtn = findOne(view.tree, (n) => n.tag === 'button')
  assert.match(textOf(pillBtn), /降智$/)
  pillBtn.props.onClick()
  await flush()
  assert.ok(findOne(view.tree, (n) => n.props && n.props['data-agy-degrade-card'] === 'true'))

  // Hydrogen -> also flagship, shows degrade card
  store.setCurrent({ provider: 'antigravity', model: 'gemini-4-hydrogen' })
  await flush()
  assert.ok(findOne(view.tree, (n) => n.props && n.props['data-agy-degrade-card'] === 'true'))

  // Orchestrator Neon -> NOT flagship, must NOT show degrade card
  store.setCurrent({ provider: 'antigravity', model: 'gemini-pro-orchestrator-neon' })
  await flush()
  assert.equal(findOne(view.tree, (n) => n.props && n.props['data-agy-degrade-card'] === 'true'), null)

  view.unmount()
})

test('D4 UI: QuotaPill pauses polling when hidden or idle >= 10m, refreshes on wake, and polls while activeTurns > 0', async () => {
  let nowMs = FIXED_NOW
  let quotaCalls = 0
  let activeTurns = 0

  const { registered, mount, document, intervals, store } = loadClientPlugin({
    language: 'zh-CN',
    now: () => nowMs,
    remoteService: {
      status: () => ({ state: 'ready', activeTurns, accounts: [] }),
      quota: async (req) => {
        quotaCalls += 1
        return {
          status: 'ok',
          model: req.model,
          updatedAt: new Date(nowMs).toISOString(),
          groups: [{ kind: 'gemini', name: 'Gemini', description: '', buckets: [{ id: 'weekly', name: 'Weekly', window: 'weekly', remainingFraction: 0.9, resetTime: isoAfterHours(48) }] }],
        }
      },
    },
  })
  store.setCurrent({ provider: 'antigravity', model: 'gemini-4-neon' })

  const slot = registered.get('conversation.input.right')
  const view = mount(slot.Component, slot.meta.inject('sess-idle'))
  await flush()
  assert.equal(quotaCalls, 1, 'initial mount fetches once')
  assert.equal(intervals.size, 1, 'one quota poll interval registered')
  const [timer] = [...intervals]

  // 1. Hidden window -> timer tick is completely skipped
  document.visibilityState = 'hidden'
  nowMs += 300_000
  timer.fn()
  await flush()
  assert.equal(quotaCalls, 1, 'hidden page must not poll quota')

  // 2. Wake back to visible after >= 5m -> triggers one catch-up refresh
  document.visibilityState = 'visible'
  document.dispatch('visibilitychange', {})
  await flush()
  assert.equal(quotaCalls, 2, 'returning to visible after >= 5m refreshes once')

  // 3. Idle >= 10m with activeTurns === 0 -> timer tick skipped
  nowMs += 11 * 60_000
  timer.fn()
  await flush()
  assert.equal(quotaCalls, 2, 'idle >= 10m with no active turns must not poll')

  // 4. User activity (keydown) resets idle clock -> next tick refreshes
  document.dispatch('keydown', { key: 'a' })
  timer.fn()
  await flush()
  assert.equal(quotaCalls, 3, 'recent user activity resumes polling')

  // 5. Idle >= 10m again, but activeTurns > 0 (streaming) -> still refreshes
  activeTurns = 1
  // Sync runtimeStatus with activeTurns=1 first
  document.dispatch('pointerdown', {})
  timer.fn()
  await flush()
  assert.equal(quotaCalls, 4)
  nowMs += 15 * 60_000
  timer.fn()
  await flush()
  assert.equal(quotaCalls, 5, 'active streaming turn keeps quota refresh alive')

  view.unmount()
})

test('D6 UI: Re-login on an already signed-in account stays open, supports Enter submit, retry link on error, and Windows isolation hint', async () => {
  const submitted = []
  let loginResult = { ok: false, email: undefined, error: 'agy exited with code 1 token exchange failed: invalid_grant' }
  const rows = [
    accountRow('default', { system: true, email: 'main@example.com', state: 'ready', hasRefreshToken: true }),
    accountRow('acc-2', { system: false, label: 'Work', email: 'work@example.com', state: 'ready', hasRefreshToken: true }),
  ]

  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => ({
        ...accountsStatus(rows),
        platform: 'win32',
        multiAccountMode: 'concurrent',
        activeAccountId: 'default',
      }),
      accounts: async () => rows,
      quota: async () => ({ status: 'ok', updatedAt: new Date(FIXED_NOW).toISOString(), groups: [] }),
      login: async (req) => ({
        accountId: req.accountId,
        url: 'https://accounts.google.com/o/oauth2/auth?state=relogin',
        command: "$env:WSL_INTEROP='dsh-isolated-slot'; & 'G:\\agy\\agy.exe' acp --login",
      }),
      loginCode: async (req) => {
        submitted.push(req)
        return loginResult
      },
      cancelLogin: async () => ({ ...accountsStatus(rows), platform: 'win32' }),
    },
  })

  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  // Open Edit modal on acc-2 (already signed in as work@example.com) and click 重新登录
  const workCard = () => findOne(view.tree, (n) => n.props && n.props['data-agy-account'] === 'acc-2')
  findOne(workCard(), (n) => n.tag === 'button' && textOf(n) === '编辑').props.onClick()
  await flush()
  findOne(view.tree, (n) => n.tag === 'button' && textOf(n) === '重新登录').props.onClick()
  await flush()
  await flush()

  // Ticket MUST stay open despite accounts() immediately returning the existing work@example.com!
  const codeInput = findOne(workCard(), (n) => n.tag === 'input' && n.props['aria-label'] === '授权码')
  assert.ok(codeInput, 're-login ticket must stay open instead of closing on prior email')
  assert.ok(findOne(workCard(), (n) => n.props && n.props['data-agy-ticket-isolated-note'] === 'true'),
    'Windows non-system ticket displays isolated sign-in note')

  // Paste code and press Enter -> submits loginCode and surfaces stdout error + New link button
  codeInput.props.onChange({ target: { value: '4/0BAD_CODE' } })
  await flush()
  findOne(workCard(), (n) => n.tag === 'input' && n.props['aria-label'] === '授权码').props.onKeyDown({ key: 'Enter' })
  await flush()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].code, '4/0BAD_CODE')
  assert.match(textOf(workCard()), /invalid_grant/)
  assert.ok(findOne(workCard(), (n) => n.props && n.props['data-agy-retry-login'] === 'acc-2'),
    'failed login offers one-click retry link button')

  // Succeed on second attempt
  loginResult = { ok: true, email: 'work-fresh@example.com', error: undefined }
  findOne(workCard(), (n) => n.tag === 'input' && n.props['aria-label'] === '授权码').props.onKeyDown({ key: 'Enter' })
  await flush()
  assert.equal(findOne(workCard(), (n) => n.tag === 'input' && n.props['aria-label'] === '授权码'), null, 'ticket closes on successful submit')
  assert.match(textOf(workCard()), /已登录 work-fresh@example\.com/)

  view.unmount()
})

test('SettingsCard offers explicit 1M window, labels locked Auto honestly, and renders upstream open model chips + authError on AccountCard', async () => {
  const patches = []
  let currentWindow = 0
  const rows = [
    {
      id: 'default',
      label: 'This Mac',
      system: true,
      enabled: true,
      state: 'ready',
      sessions: 1,
      email: 'pro@example.com',
      subscriptionTier: 'PRO',
      subscriptionName: 'Google AI Pro',
      argonSharedWithGemini: true,
      entitledModels: [
        { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
        { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
      ],
      availableModels: [
        { id: 'gemini-4-neon', name: 'Gemini 4 Neon', enabled: true },
        { id: 'gemini-4-argon', name: 'Gemini 4 Argon', enabled: true },
      ],
      visibleModels: [],
      priority: 1,
      weight: 1,
    },
    {
      id: 'acc-expired',
      label: 'Expired Free',
      system: false,
      enabled: false,
      state: 'idle',
      sessions: 0,
      email: 'expired@example.com',
      subscriptionTier: 'FREE',
      subscriptionName: 'Antigravity Starter Quota',
      authError: 'Antigravity OAuth token expired or revoked (HTTP 401)',
      entitledModels: [
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      ],
      disabledModels: ['gemini-4-argon'],
      visibleModels: [],
      priority: 3,
      weight: 1,
    },
  ]
  const snapshot = () => ({
    state: 'ready',
    version: '1.5.16',
    unlock: { status: 'locked', applied: false, detail: 'unlock script missing' },
    contextWindow: currentWindow > 0 ? currentWindow : 256_000,
    configuredContextWindow: currentWindow,
    defaultEffort: 'high',
    longDecodeContinuations: 3,
    degradeAction: 'truncation',
    engineMode: 'bridge',
    realUsageCompaction: true,
    models: rows[0].entitledModels,
    availableModels: rows[0].entitledModels.map((m) => ({ ...m, enabled: true })),
    visibleModels: [],
    accounts: rows,
  })

  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => snapshot(),
      accounts: async () => rows,
      configure: async (patch) => {
        patches.push(patch)
        if ('contextWindow' in patch) currentWindow = patch.contextWindow
        return snapshot()
      },
      quota: async () => ({
        status: 'ok',
        subscriptionTier: 'PRO',
        subscriptionName: 'Google AI Pro',
        argonSharedWithGemini: true,
        availableModels: rows[0].entitledModels,
        groups: [
          {
            kind: 'gemini',
            name: 'Gemini 4 Neon / Carbon / Argon / Hydrogen / 3.8',
            description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
            buckets: [{ id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.93, resetTime: '2026-12-02T01:59:13Z' }],
          },
        ],
      }),
    },
  })

  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  // Locked binary shows honest warning tag and Auto (256K · locked) label, plus explicit 1M option
  assert.ok(findOne(view.tree, (n) => n.props && n.props['data-agy-unlock'] === 'locked'))
  const windowRow = findAll(view.tree, (n) => n.props && n.props['aria-expanded'] !== undefined)[0]
  assert.match(textOf(windowRow), /自动 \(256K · 未解锁\)/)
  windowRow.props.onClick()
  await flush()
  const opts = findAll(view.tree, (n) => n.tag === 'button' && n.props['aria-checked'] !== undefined)
  assert.deepEqual(opts.map(textOf), ['自动 (256K · 未解锁)', '1M', '900K', '512K', '256K'])
  opts[1].props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ contextWindow: 1048576 }])
  assert.match(textOf(findAll(view.tree, (n) => n.props && n.props['aria-expanded'] !== undefined)[0]), /上下文窗口1M/)

  // Default account card immediately displays all 8 upstream open models without opening Quota drawer
  const defaultCard = findOne(view.tree, (n) => n.props && n.props['data-agy-account'] === 'default')
  const defaultChips = findAll(defaultCard, (n) => n.props && 'data-agy-model-chip' in n.props)
  assert.equal(defaultChips.length, 8)
  assert.ok(defaultChips.some((c) => c.props['data-agy-model-chip'] === 'gemini-4-argon'))

  // Expanding Quota drawer labels the multi-model Gemini 4 pool as Gemini 4 / 3.8 额度
  findOne(defaultCard, (n) => n.tag === 'button' && textOf(n) === '额度').props.onClick()
  await flush()
  const updatedDefault = findOne(view.tree, (n) => n.props && n.props['data-agy-account'] === 'default')
  assert.match(textOf(updatedDefault), /Gemini 4 \/ 3\.8 额度/)

  // Expired account card surfaces Token expired badge, auth banner, and disabled model chip
  const expiredCard = findOne(view.tree, (n) => n.props && n.props['data-agy-account'] === 'acc-expired')
  assert.ok(findOne(expiredCard, (n) => n.props && n.props['data-agy-auth-badge'] === 'true'))
  assert.ok(findOne(expiredCard, (n) => n.props && n.props['data-agy-health-banner'] === 'auth'))
  assert.ok(findOne(expiredCard, (n) => n.props && n.props['data-agy-model-disabled'] === 'gemini-4-argon'))

  view.unmount()
})

test('AccountCard with empty entitledModels never borrows provider catalog and recheckAccount surfaces quota errors', async () => {
  const rows = [
    {
      id: 'acc-free-expired',
      label: 'Expired Free',
      system: false,
      enabled: false,
      state: 'idle',
      sessions: 0,
      email: 'free@example.com',
      subscriptionTier: 'FREE',
      subscriptionName: 'Antigravity Starter Quota',
      authError: 'Antigravity OAuth token expired or revoked (HTTP 401)',
      entitledModels: [],
      availableModels: [
        { id: 'gemini-4-neon', name: 'Gemini 4 Neon', enabled: true },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', enabled: true },
      ],
      visibleModels: [],
      priority: 3,
      weight: 1,
    },
  ]
  const snap = {
    state: 'ready',
    version: '1.5.16',
    contextWindow: 1_048_576,
    configuredContextWindow: 0,
    defaultEffort: 'high',
    longDecodeContinuations: 3,
    models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
    availableModels: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', enabled: true }],
    visibleModels: [],
    accounts: rows,
  }
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => snap,
      accounts: async () => rows,
      recheckAccount: async () => ({
        status: snap,
        quota: { status: 'error', groups: [], error: 'Antigravity OAuth token expired or revoked (HTTP 401)' },
      }),
    },
  })

  const slot = registered.get('settings.section')
  const view = mount(slot.Component, slot.meta.inject())
  await flush()

  const card = findOne(view.tree, (n) => n.props && n.props['data-agy-account'] === 'acc-free-expired')
  assert.equal(findAll(card, (n) => n.props && 'data-agy-model-chip' in n.props).length, 0,
    'explicit empty entitledModels must not leak provider PRO catalog onto unprobed FREE account')

  // Clicking 重新检测 on a 401 account reports error instead of falsely saying healthy
  const recheckBtn = findOne(card, (n) => n.props && n.props['data-agy-recheck-btn'] === 'acc-free-expired')
  assert.ok(recheckBtn)
  recheckBtn.props.onClick()
  await flush()
  const updatedCard = findOne(view.tree, (n) => n.props && n.props['data-agy-account'] === 'acc-free-expired')
  assert.match(textOf(updatedCard), /HTTP 401/)
  assert.doesNotMatch(textOf(updatedCard), /重新检测通过/)

  view.unmount()
})

test('QuotaPill blocks switching into suspended/expired accounts with badge, AccountCard hides Set default, and AccountEditorModal exports backup path', async () => {
  const calls = []
  const rows = [
    {
      id: 'default', label: 'Primary', system: true, enabled: true, active: true,
      state: 'ready', sessions: 1, email: 'primary@example.com', hasRefreshToken: true,
      subscriptionTier: 'PRO', subscriptionName: 'Google AI Pro',
      env: {}, home: '', contextWindow: 0, visibleModels: [], priority: 1, weight: 1, cooldowns: [],
    },
    {
      id: 'acc-tos', label: 'Suspended', system: false, enabled: false, active: false,
      state: 'idle', sessions: 0, email: 'tos@example.com', hasRefreshToken: true,
      tosSuspended: true,
      env: {}, home: '', contextWindow: 0, visibleModels: [], priority: 2, weight: 1, cooldowns: [],
    },
    {
      id: 'acc-expired', label: 'Expired', system: false, enabled: false, active: false,
      state: 'idle', sessions: 0, email: 'expired@example.com', hasRefreshToken: true,
      authError: 'OAuth token expired or revoked (HTTP 401)',
      env: {}, home: '', contextWindow: 0, visibleModels: [], priority: 3, weight: 1, cooldowns: [],
    },
  ]
  const snap = {
    state: 'ready', version: '1.5.16', platform: 'win32', activeAccountId: 'default',
    contextWindow: 1_048_576, configuredContextWindow: 0, defaultEffort: 'high', longDecodeContinuations: 3,
    models: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon' }],
    availableModels: [{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', enabled: true }],
    visibleModels: [], accounts: rows,
  }
  const { registered, mount } = loadClientPlugin({
    language: 'zh-CN',
    remoteService: {
      status: async () => snap,
      accounts: async () => rows,
      quota: async () => ({ status: 'ok', accountId: 'default', groups: [] }),
      switchAccount: async (req) => { calls.push({ method: 'switchAccount', req }); return snap },
      exportCredential: async (req) => {
        calls.push({ method: 'exportCredential', req })
        return {
          accountId: req.accountId,
          email: 'primary@example.com',
          filePath: 'C:\\cache\\credential-backups\\primary_example.com-2026-11-25.json',
          hasRefreshToken: true,
          exportedAt: '2026-11-25T06:00:00.000Z',
        }
      },
    },
  })

  // 1. QuotaPill disables switching into ToS-suspended and auth-expired rows and shows 凭据失效 badge
  const pillSlot = registered.get('conversation.input.right')
  const pillView = mount(pillSlot.Component, pillSlot.meta.inject('sess-ui-guard'))
  await flush()
  const trigger = findOne(pillView.tree, (n) => n.tag === 'button')
  assert.ok(trigger)
  trigger.props.onClick()
  await flush()

  const tosRow = findOne(pillView.tree, (n) => n.props && n.props['data-agy-pill-switch-account'] === 'acc-tos')
  const expRow = findOne(pillView.tree, (n) => n.props && n.props['data-agy-pill-switch-account'] === 'acc-expired')
  assert.equal(tosRow.props.disabled, true, 'ToS-suspended account must be disabled in QuotaPill switcher')
  assert.equal(expRow.props.disabled, true, 'auth-expired account must be disabled in QuotaPill switcher')
  assert.ok(findOne(expRow, (n) => n.props && n.props['data-agy-pill-auth-expired'] === 'true'))
  assert.match(textOf(expRow), /凭据失效/)
  // Clicking disabled rows must not call switchAccount
  tosRow.props.onClick()
  expRow.props.onClick()
  await flush()
  assert.equal(calls.filter(c => c.method === 'switchAccount').length, 0)
  pillView.unmount()

  // 2. Settings section hides Set default for ToS/expired accounts and supports Export backup in AccountEditorModal
  const settingsSlot = registered.get('settings.section')
  const settingsView = mount(settingsSlot.Component, settingsSlot.meta.inject())
  await flush()

  const tosCard = findOne(settingsView.tree, (n) => n.props && n.props['data-agy-account'] === 'acc-tos')
  const expCard = findOne(settingsView.tree, (n) => n.props && n.props['data-agy-account'] === 'acc-expired')
  assert.equal(findOne(tosCard, (n) => n.props && n.props['data-agy-switch-btn'] === 'acc-tos'), null, 'ToS card must not render Set default')
  assert.equal(findOne(expCard, (n) => n.props && n.props['data-agy-switch-btn'] === 'acc-expired'), null, 'auth-expired card must not render Set default')

  const primaryCard = findOne(settingsView.tree, (n) => n.props && n.props['data-agy-account'] === 'default')
  const editBtn = findOne(primaryCard, (n) => n.tag === 'button' && textOf(n) === '编辑')
  assert.ok(editBtn)
  editBtn.props.onClick()
  await flush()

  const exportBtn = findOne(settingsView.tree, (n) => n.props && n.props['data-agy-export-backup-btn'] === 'default')
  assert.ok(exportBtn, 'AccountEditorModal must render Export backup button')
  exportBtn.props.onClick()
  await flush()
  assert.equal(calls.filter(c => c.method === 'exportCredential').length, 1)
  assert.equal(calls[0].req.accountId, 'default')
  const notice = findOne(settingsView.tree, (n) => n.props && n.props['data-agy-editor-notice'] === 'default')
  assert.ok(notice)
  assert.match(textOf(notice), /credential-backups/)
  settingsView.unmount()
})
