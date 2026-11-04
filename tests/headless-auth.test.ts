/** Fresh account checks and reversible, per-profile headless opt-in. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHeadlessAuth, type HeadlessAuthOptions } from '../src/host/headless-auth.ts'

const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown }
const client = { version: '0.2.1-rc.2', locale: 'en', timezoneOffsetSeconds: 28_800 }

async function fixture(options: Partial<HeadlessAuthOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-headless-auth-'))
  const directory = join(home, 'profiles', 'headless')
  const profile = join(directory, 'cordis.patch.yml')
  const history = join(directory, '.wsl-headless-auth-state.yml')
  const service = createHeadlessAuth({ dshHome: home, client, ...options })
  return {
    home, directory, profile, history, service,
    async seed(text: string) { await mkdir(directory, { recursive: true }); await writeFile(profile, text, 'utf8') },
    async cleanup() {
      // This exact mkdtemp directory is the only recursive cleanup target.
      assert.equal(resolve(home), home)
      assert.ok(home.startsWith(join(tmpdir(), 'dsh-headless-auth-')))
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('a green check requires a fresh ready balance result and returns no account data', async () => {
  let calls = 0
  const f = await fixture({ account: () => ({ getBalance: async metadata => {
    calls += 1
    assert.deepEqual(metadata, client)
    return { status: 'ready' }
  } }) })
  try {
    assert.deepEqual(await f.service.check(), { status: 'connected' })
    assert.deepEqual(await f.service.check(), { status: 'connected' })
    assert.equal(calls, 2, 'the second check must not reuse an earlier green result')
    assert.deepEqual(await f.service.status(), { permanent: false, managed: false, canReset: false })
    assert.deepEqual(await readdir(f.home), [], 'checking must not create a profile or copy credentials')
  } finally { await f.cleanup() }
})

test('unavailable, signed-out and failed account checks remain distinct', async () => {
  const absent = await fixture()
  const signedOut = await fixture({ account: () => ({ getBalance: async () => null }) })
  const failed = await fixture({ account: () => ({ getBalance: async () => ({ status: 'failed' }) }) })
  const rejected = await fixture({ account: () => ({ getBalance: async () => { throw new Error('private response') } }) })
  try {
    assert.deepEqual(await absent.service.check(), { status: 'unavailable', reason: 'service-unavailable' })
    assert.deepEqual(await signedOut.service.check(), { status: 'signed-out' })
    assert.deepEqual(await failed.service.check(), { status: 'failed', reason: 'connection-failed' })
    assert.deepEqual(await rejected.service.check(), { status: 'failed', reason: 'connection-failed' })
  } finally { await Promise.all([absent, signedOut, failed, rejected].map(f => f.cleanup())) }
})

test('a timed-out check cannot become green when the abandoned request later resolves', async () => {
  let finish: ((value: { status: 'ready' }) => void) | undefined
  let calls = 0
  const f = await fixture({ checkTimeoutMs: 5, account: () => ({ getBalance: async () => {
    calls += 1
    if (calls > 1) return null
    return new Promise(resolve => { finish = resolve })
  } }) })
  try {
    assert.deepEqual(await f.service.check(), { status: 'failed', reason: 'timeout' })
    finish?.({ status: 'ready' })
    assert.deepEqual(await f.service.check(), { status: 'signed-out' }, 'a retry must make its own request')
  } finally { await f.cleanup() }
})

test('one-time configuration returns the account overlay without writing a profile', async () => {
  const f = await fixture({ selection: () => ({ provider: 'deepseek-account', model: 'deepseek-v4-pro' }) })
  try {
    const result = await f.service.configure('once')
    assert.equal(result.scope, 'once')
    assert.equal(result.filename, 'headless-account.patch.yml')
    const rows = yaml.load(result.yaml ?? '') as Array<{ id: string; disabled?: boolean; config?: { provider: string; model: string } }>
    assert.deepEqual(rows.slice(0, 3).map(row => [row.id, row.disabled]), [['credentials', false], ['authorization', false], ['deepseek-account', false]])
    assert.deepEqual(rows[3]?.config, { provider: 'deepseek-account', model: 'deepseek-v4-pro' })
    assert.deepEqual(await readdir(f.home), [])
  } finally { await f.cleanup() }
})

test('a different provider model is not copied onto the account route', async () => {
  const f = await fixture({ selection: () => ({ provider: 'another-provider', model: 'another-model' }) })
  try { assert.match((await f.service.configure('once')).yaml ?? '', /model: deepseek-flash/) }
  finally { await f.cleanup() }
})

test('permanent opt-in preserves other config and reset restores only managed fields', async () => {
  const f = await fixture()
  try {
    await f.seed(`- id: unrelated
  config:
    apiKey: do-not-copy-into-history
- id: credentials
  disabled: true
  config:
    watch: false
- id: agent-default-model
  config:
    provider: deepseek-official
    model: original-model
    reasoningEffort: high
`)
    assert.deepEqual(await f.service.configure('permanent'), { scope: 'permanent', permanent: true, managed: true, canReset: true })
    assert.equal((await f.service.status()).permanent, true)
    const history = await readFile(f.history, 'utf8')
    assert.ok(!history.includes('do-not-copy-into-history'), 'history must contain only the four managed entries')
    const enabled = yaml.load(await readFile(f.profile, 'utf8')) as Array<Record<string, unknown>>
    const model = enabled.find(row => row.id === 'agent-default-model') as { config: Record<string, unknown> }
    model.config.reasoningEffort = 'max'
    // A user change outside provider/model must survive restoration.
    await writeFile(f.profile, (createRequire(import.meta.url)('js-yaml') as { dump(value: unknown): string }).dump(enabled))
    assert.deepEqual(await f.service.configure('reset'), { scope: 'reset', permanent: false, managed: false, canReset: false })
    const restored = yaml.load(await readFile(f.profile, 'utf8')) as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    assert.equal(restored.find(row => row.id === 'credentials')?.disabled, true)
    assert.equal(restored.find(row => row.id === 'credentials')?.config?.watch, false)
    assert.deepEqual(restored.find(row => row.id === 'agent-default-model')?.config, { provider: 'deepseek-official', model: 'original-model', reasoningEffort: 'max' })
    assert.ok(!restored.some(row => row.id === 'authorization'))
    assert.ok(!restored.some(row => row.id === 'deepseek-account'))
    await assert.rejects(readFile(f.history), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('reset removes the profile created by the opt-in when no other entries remain', async () => {
  const f = await fixture()
  try {
    await f.service.configure('permanent')
    await f.service.configure('reset')
    await assert.rejects(readFile(f.profile), { code: 'ENOENT' })
    await assert.rejects(readFile(f.history), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('!!js remains a tagged expression and is never executed during persistence', async () => {
  const f = await fixture()
  try {
    await f.seed(`- id: unrelated
  disabled: !!js (() => { throw new Error('must not execute') })()
- id: agent-default-model
  config:
    provider: !!js process.env.PROVIDER
    model: old-model
`)
    await f.service.configure('permanent')
    assert.match(await readFile(f.profile, 'utf8'), /disabled: !!js/)
    await f.service.configure('reset')
    assert.match(await readFile(f.profile, 'utf8'), /provider: !!js process\.env\.PROVIDER/)
  } finally { await f.cleanup() }
})

test('externally changed managed fields are refused without overwriting them', async () => {
  const f = await fixture()
  try {
    await f.service.configure('permanent')
    const external = (await readFile(f.profile, 'utf8')).replace('model: deepseek-flash', 'model: user-selected-model')
    await writeFile(f.profile, external)
    await assert.rejects(f.service.configure('reset'), { code: 'CONFIG_CONFLICT' })
    await assert.rejects(f.service.configure('permanent'), { code: 'CONFIG_CONFLICT' })
    assert.equal(await readFile(f.profile, 'utf8'), external)
  } finally { await f.cleanup() }
})

test('existing manual account defaults are recognized without claiming ownership', async () => {
  const f = await fixture()
  try {
    const once = await f.service.configure('once')
    await f.seed(once.yaml ?? '')
    assert.deepEqual(await f.service.status(), { permanent: true, managed: false, canReset: false })
    await f.service.configure('permanent')
    await assert.rejects(readFile(f.history), { code: 'ENOENT' })
    await assert.rejects(f.service.configure('reset'), { code: 'CONFIG_CONFLICT' })
  } finally { await f.cleanup() }
})

test('duplicate ids and invalid YAML are rejected without changing the profile', async () => {
  const f = await fixture()
  try {
    for (const source of ['- id: credentials\n- id: credentials\n', '- id: [broken\n']) {
      await f.seed(source)
      await assert.rejects(f.service.configure('permanent'), { code: 'CONFIG_INVALID' })
      assert.equal(await readFile(f.profile, 'utf8'), source)
      await assert.rejects(readFile(f.history), { code: 'ENOENT' })
    }
  } finally { await f.cleanup() }
})

test('parallel writers preserve unrelated settings and leave no held lock', async () => {
  const f = await fixture()
  try {
    await f.seed('- id: unrelated\n  config: { keep: true }\n')
    const second = createHeadlessAuth({ dshHome: f.home, client })
    await Promise.all([f.service.configure('permanent'), second.configure('permanent')])
    const rows = yaml.load(await readFile(f.profile, 'utf8')) as Array<{ id: string }>
    assert.equal(rows.length, 5)
    assert.equal(new Set(rows.map(row => row.id)).size, 5)
    await assert.rejects(readFile(join(f.directory, 'package.json.lock')), { code: 'ENOENT' })
    await second.configure('reset')
    assert.deepEqual(yaml.load(await readFile(f.profile, 'utf8')), [{ id: 'unrelated', config: { keep: true } }])
  } finally { await f.cleanup() }
})

test('an interrupted prepare or reset is recoverable from the managed fields', async () => {
  const f = await fixture()
  const original = '- id: unrelated\n  config: { keep: true }\n'
  try {
    await f.seed(original)
    await f.service.configure('permanent')
    // Journal committed, profile rename did not: the original fields are intact.
    await writeFile(f.profile, original)
    assert.deepEqual(await f.service.status(), { permanent: false, managed: false, canReset: false })
    await f.service.configure('permanent')
    assert.equal((await f.service.status()).managed, true)
    // Profile restored, history removal did not: a repeated reset just retires history.
    await writeFile(f.profile, original)
    await f.service.configure('reset')
    assert.equal(await readFile(f.profile, 'utf8'), original)
    await assert.rejects(readFile(f.history), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('an interrupted model-changing reapply can retry or reset to the original baseline', async () => {
  let model = 'model-A'
  const f = await fixture({ selection: () => ({ provider: 'deepseek-account', model }) })
  try {
    await f.service.configure('permanent')
    const versionA = await readFile(f.profile, 'utf8')
    model = 'model-B'
    await f.service.configure('permanent')
    // The B journal committed, but its profile rename did not. A remains active.
    await writeFile(f.profile, versionA)
    assert.deepEqual(await f.service.status(), { permanent: true, managed: true, canReset: true })
    await f.service.configure('permanent')
    const versionB = await readFile(f.profile, 'utf8')
    assert.match(versionB, /model: model-B/)

    model = 'model-C'
    await f.service.configure('permanent')
    // A later interrupted reapply must retain the original (absent-profile) baseline.
    await writeFile(f.profile, versionB)
    assert.deepEqual(await f.service.status(), { permanent: true, managed: true, canReset: true })
    assert.deepEqual(await f.service.configure('reset'), { scope: 'reset', permanent: false, managed: false, canReset: false })
    await assert.rejects(readFile(f.profile), { code: 'ENOENT' })
    await assert.rejects(readFile(f.history), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('a non-cooperating edit detected before commit retains the edit and rolls back history', async () => {
  let profile = ''
  const external = '- id: externally-added\n  config: { keep: true }\n'
  const f = await fixture({ selection: () => {
    writeFileSync(profile, external)
    return { provider: 'deepseek-account', model: 'deepseek-flash' }
  } })
  profile = f.profile
  try {
    await f.seed('- id: original\n')
    await assert.rejects(f.service.configure('permanent'), { code: 'CONFIG_CONFLICT' })
    assert.equal(await readFile(f.profile, 'utf8'), external)
    await assert.rejects(readFile(f.history), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})
