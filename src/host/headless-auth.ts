/** Account connectivity and opt-in headless authentication settings. */
import { createRequire } from 'node:module'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export interface AccountClientMetadata {
  version: string
  locale: string
  timezoneOffsetSeconds: number
}

/** Only the fresh balance outcome is used; account/profile caches are not proof. */
export interface HeadlessAccount {
  getBalance(client: AccountClientMetadata): Promise<{ status: 'ready' | 'failed' } | null>
}

export interface HeadlessAuthOptions {
  dshHome: string
  account?: () => HeadlessAccount | undefined
  selection?: () => { provider: string; model: string }
  client: AccountClientMetadata
  /** Test seam; the production wait is always bounded to twelve seconds. */
  checkTimeoutMs?: number
}

export interface HeadlessAuthStatus {
  permanent: boolean
  managed: boolean
  canReset: boolean
}

export interface HeadlessAuthCheck {
  status: 'connected' | 'signed-out' | 'unavailable' | 'failed'
  reason?: 'timeout' | 'connection-failed' | 'service-unavailable'
}

export type HeadlessAuthScope = 'once' | 'permanent' | 'reset'

export interface HeadlessAuthConfiguration extends HeadlessAuthStatus {
  scope: HeadlessAuthScope
  yaml?: string
  filename?: string
}

export class HeadlessAuthError extends Error {
  code: 'INVALID_SCOPE' | 'CONFIG_INVALID' | 'CONFIG_CONFLICT' | 'CONFIG_BUSY' | 'WRITE_FAILED'

  constructor(code: HeadlessAuthError['code'], detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'HeadlessAuthError'
    this.code = code
  }
}

type Row = Record<string, unknown>
type Field = { present: boolean; value?: unknown }
type SavedRow = { id: string; existed: boolean; configExisted: boolean; fields: Record<string, Field> }
interface ManagedState {
  version: 1
  profileExisted: boolean
  before: SavedRow[]
  applied: SavedRow[]
  /** The actual fields immediately before this transaction's profile rename. */
  previous?: SavedRow[]
}

const AUTH_IDS = ['credentials', 'authorization', 'deepseek-account'] as const
const MODEL_ID = 'agent-default-model'
const IDS = [...AUTH_IDS, MODEL_ID]
const CHECK_TIMEOUT_MS = 12_000

/** Keep !!js as a tagged data value when editing the user's patch. */
class JsExpression {
  source: string
  constructor(source: string) { this.source = source }
}

interface YamlEngine {
  load(source: string, options: { schema: unknown }): unknown
  dump(value: unknown, options: { schema: unknown; lineWidth: number; noCompatMode: boolean }): string
  JSON_SCHEMA: { extend(type: unknown): unknown }
  Type: new (tag: string, options: {
    kind: 'scalar'
    resolve(data: unknown): boolean
    construct(data: string): unknown
    predicate(value: unknown): boolean
    represent(value: JsExpression): string
  }) => unknown
}

function yamlEngine(): { yaml: YamlEngine; schema: unknown } {
  const require = createRequire(import.meta.url)
  const path = require.resolve('js-yaml')
  const { version } = require('js-yaml/package.json') as { version: string }
  const yaml = require('js-yaml') as YamlEngine
  if (typeof yaml.load !== 'function' || typeof yaml.dump !== 'function' || typeof yaml.Type !== 'function' || typeof yaml.JSON_SCHEMA?.extend !== 'function') {
    throw new HeadlessAuthError('CONFIG_INVALID', `js-yaml ${version} at ${path} cannot express the entry-list dialect`)
  }
  const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: data => typeof data === 'string',
    construct: data => new JsExpression(data),
    predicate: value => value instanceof JsExpression,
    represent: value => value.source,
  }))
  return { yaml, schema }
}

function object(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw new HeadlessAuthError('WRITE_FAILED', 'headless settings could not be read')
  }
}

function parse(text: string, metadata = false): unknown {
  const { yaml, schema } = yamlEngine()
  try { return yaml.load(text, { schema }) } catch {
    // Parser errors may quote configuration contents, so only a stable diagnosis
    // crosses the HTTP route. The credential store is never opened by this module.
    throw new HeadlessAuthError('CONFIG_INVALID', metadata ? 'headless settings history is invalid' : 'headless profile must contain valid entry-list YAML')
  }
}

function render(value: unknown): string {
  const { yaml, schema } = yamlEngine()
  return yaml.dump(value, { schema, lineWidth: -1, noCompatMode: true })
}

function rowsOf(text: string | undefined): Row[] {
  if (text === undefined || text.trim() === '') return []
  const value = parse(text)
  if (!Array.isArray(value) || value.some(row => !object(row))) throw new HeadlessAuthError('CONFIG_INVALID', 'headless profile must be a sequence of entries')
  const seen = new Set<string>()
  for (const row of value as Row[]) {
    if (row.id === undefined) continue // An insert patch has no root id.
    if (typeof row.id !== 'string' || seen.has(row.id)) throw new HeadlessAuthError('CONFIG_INVALID', 'headless profile has an invalid or repeated entry id')
    seen.add(row.id)
  }
  const model = (value as Row[]).find(row => row.id === MODEL_ID)
  if (model !== undefined && Object.hasOwn(model, 'config') && !object(model.config)) {
    throw new HeadlessAuthError('CONFIG_INVALID', 'the default model config must be a mapping')
  }
  return value as Row[]
}

function field(container: Row | undefined, name: string): Field {
  return container !== undefined && Object.hasOwn(container, name)
    ? { present: true, value: container[name] }
    : { present: false }
}

function capture(rows: Row[]): SavedRow[] {
  return IDS.map(id => {
    const row = rows.find(value => value.id === id)
    const config = object(row?.config) ? row.config : undefined
    return {
      id, existed: row !== undefined, configExisted: row !== undefined && Object.hasOwn(row, 'config'),
      fields: id === MODEL_ID ? { provider: field(config, 'provider'), model: field(config, 'model') } : { disabled: field(row, 'disabled') },
    }
  })
}

function validateSaved(value: unknown): value is SavedRow[] {
  if (!Array.isArray(value) || value.length !== IDS.length) return false
  return value.every((row, index) => {
    if (!object(row) || row.id !== IDS[index] || typeof row.existed !== 'boolean' || typeof row.configExisted !== 'boolean' || !object(row.fields)) return false
    const keys = row.id === MODEL_ID ? ['provider', 'model'] : ['disabled']
    return Object.keys(row.fields).length === keys.length && keys.every(key => {
      const saved = (row.fields as Row)[key]
      return object(saved) && typeof saved.present === 'boolean' && (saved.present === Object.hasOwn(saved, 'value'))
    })
  })
}

function stateOf(text: string | undefined): ManagedState | undefined {
  if (text === undefined) return undefined
  const value = parse(text, true)
  if (!object(value) || value.version !== 1 || typeof value.profileExisted !== 'boolean' || !validateSaved(value.before) || !validateSaved(value.applied)
    || (value.previous !== undefined && !validateSaved(value.previous))) {
    throw new HeadlessAuthError('CONFIG_INVALID', 'headless settings history is invalid')
  }
  return value as unknown as ManagedState
}

function matches(rows: Row[], saved: SavedRow[]): boolean {
  const actual = capture(rows)
  return saved.every((row, index) => isDeepStrictEqual(row.fields, actual[index]?.fields))
}

function permanent(rows: Row[]): boolean {
  return AUTH_IDS.every(id => rows.find(row => row.id === id)?.disabled === false)
    && rows.some(row => row.id === MODEL_ID && object(row.config) && row.config.provider === 'deepseek-account' && typeof row.config.model === 'string' && row.config.model !== '')
}

function summary(rows: Row[], state: ManagedState | undefined): HeadlessAuthStatus {
  const initial = state !== undefined && matches(rows, state.before)
  const applied = state !== undefined && matches(rows, state.applied)
  const previous = state?.previous !== undefined && matches(rows, state.previous)
  if (state !== undefined && !applied && !initial && !previous) {
    throw new HeadlessAuthError('CONFIG_CONFLICT', 'managed headless fields changed outside this plugin')
  }
  const managed = applied || (previous && !initial)
  return { permanent: permanent(rows), managed, canReset: managed }
}

function selectedModel(options: HeadlessAuthOptions): string {
  let selection: { provider: string; model: string } | undefined
  try { selection = options.selection?.() } catch {
    throw new HeadlessAuthError('CONFIG_INVALID', 'the current model selection could not be read')
  }
  return selection?.provider === 'deepseek-account' && typeof selection.model === 'string' && selection.model.trim() !== '' ? selection.model : 'deepseek-flash'
}

function overlay(model: string): Row[] {
  return [...AUTH_IDS.map(id => ({ id, disabled: false })), { id: MODEL_ID, config: { provider: 'deepseek-account', model } }]
}

function apply(rows: Row[], model: string): void {
  for (const desired of overlay(model)) {
    let row = rows.find(value => value.id === desired.id)
    if (row === undefined) { row = { id: desired.id }; rows.push(row) }
    if (desired.id === MODEL_ID) row.config = { ...(object(row.config) ? row.config : {}), provider: 'deepseek-account', model }
    else row.disabled = false
  }
}

function restore(rows: Row[], saved: SavedRow[]): void {
  for (const original of saved) {
    const row = rows.find(value => value.id === original.id)
    if (row === undefined) continue
    const target = original.id === MODEL_ID ? row.config as Row : row
    for (const [key, previous] of Object.entries(original.fields)) {
      if (previous.present) target[key] = previous.value
      else delete target[key]
    }
    if (original.id === MODEL_ID && !original.configExisted && Object.keys(target).length === 0) delete row.config
    if (!original.existed && Object.keys(row).every(key => key === 'id')) rows.splice(rows.indexOf(row), 1)
  }
}

/** All paths are chosen on the host; HTTP callers can choose only the scope. */
export function createHeadlessAuth(options: HeadlessAuthOptions): {
  status(): Promise<HeadlessAuthStatus>
  check(): Promise<HeadlessAuthCheck>
  configure(scope: HeadlessAuthScope): Promise<HeadlessAuthConfiguration>
} {
  const directory = join(options.dshHome, 'profiles', 'headless')
  const profilePath = join(directory, 'cordis.patch.yml')
  const statePath = join(directory, '.wsl-headless-auth-state.yml')
  let checking: Promise<HeadlessAuthCheck> | undefined

  async function current(): Promise<{ text: string | undefined; rows: Row[]; state: ManagedState | undefined }> {
    const [text, stateText] = await Promise.all([optionalText(profilePath), optionalText(statePath)])
    return { text, rows: rowsOf(text), state: stateOf(stateText) }
  }

  async function check(): Promise<HeadlessAuthCheck> {
    if (checking !== undefined) return checking
    checking = (async () => {
      let account: HeadlessAccount | undefined
      try { account = options.account?.() } catch { return { status: 'unavailable', reason: 'service-unavailable' } as const }
      if (account === undefined || typeof account.getBalance !== 'function') return { status: 'unavailable', reason: 'service-unavailable' } as const
      let timeout: ReturnType<typeof setTimeout> | undefined
      const elapsed = new Promise<HeadlessAuthCheck>(resolve => {
        timeout = setTimeout(() => resolve({ status: 'failed', reason: 'timeout' }), Math.max(1, Math.min(options.checkTimeoutMs ?? CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS)))
      })
      const request = Promise.resolve().then(() => account.getBalance(options.client)).then((result): HeadlessAuthCheck => {
        if (result === null) return { status: 'signed-out' }
        return object(result) && result.status === 'ready' ? { status: 'connected' } : { status: 'failed', reason: 'connection-failed' }
      }, (): HeadlessAuthCheck => ({ status: 'failed', reason: 'connection-failed' }))
      try { return await Promise.race([request, elapsed]) } finally { clearTimeout(timeout) }
    })().finally(() => { checking = undefined })
    return checking
  }

  async function configure(scope: HeadlessAuthScope): Promise<HeadlessAuthConfiguration> {
    if (!['once', 'permanent', 'reset'].includes(scope)) throw new HeadlessAuthError('INVALID_SCOPE', 'choose once, permanent or reset')
    if (scope === 'once') {
      const loaded = await current()
      return { scope, yaml: render(overlay(selectedModel(options))), filename: 'headless-account.patch.yml', ...summary(loaded.rows, loaded.state) }
    }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      return await withFileLock(join(directory, 'package.json'), async () => {
        const loaded = await current()
        const previous = summary(loaded.rows, loaded.state)
        if (scope === 'reset') {
          if (loaded.state === undefined) {
            if (previous.permanent) throw new HeadlessAuthError('CONFIG_CONFLICT', 'existing headless settings are not managed by this plugin')
            return { scope, ...previous }
          }
          // An interrupted reset already restored the fields; only its history remains.
          if (!matches(loaded.rows, loaded.state.before)) {
            restore(loaded.rows, loaded.state.before)
            if (await optionalText(profilePath) !== loaded.text) throw new HeadlessAuthError('CONFIG_CONFLICT', 'headless settings changed while saving')
            if (!loaded.state.profileExisted && loaded.rows.length === 0) await rm(profilePath, { force: true })
            else await writeFileAtomic(profilePath, render(loaded.rows), { mode: 0o600 })
          }
          await rm(statePath, { force: true })
          return { scope, ...summary(loaded.rows, undefined) }
        }
        // A manually configured profile is already permanent; do not claim ownership.
        if (loaded.state === undefined && previous.permanent) return { scope, ...previous }
        const before = loaded.state?.before ?? capture(loaded.rows)
        const previousFields = capture(loaded.rows)
        apply(loaded.rows, selectedModel(options))
        const next: ManagedState = {
          version: 1, profileExisted: loaded.state?.profileExisted ?? loaded.text !== undefined,
          before, previous: previousFields, applied: capture(loaded.rows),
        }
        // Journal first. A crash before the profile rename is recognized by `previous`,
        // even on a model-changing reapply; `before` remains the original reset baseline.
        // A crash afterwards is recognized by `applied`.
        await writeFileAtomic(statePath, render(next), { mode: 0o600 })
        try {
          if (await optionalText(profilePath) !== loaded.text) throw new HeadlessAuthError('CONFIG_CONFLICT', 'headless settings changed while saving')
          await writeFileAtomic(profilePath, render(loaded.rows), { mode: 0o600 })
        } catch (error) {
          if (loaded.state === undefined) await rm(statePath, { force: true })
          else await writeFileAtomic(statePath, render(loaded.state), { mode: 0o600 })
          throw error
        }
        return { scope, ...summary(loaded.rows, next) }
      }, { waitMs: 2_000 })
    } catch (error) {
      if (error instanceof HeadlessAuthError) throw error
      if (error instanceof Error && error.message.includes('timed out waiting for the writer lock')) {
        throw new HeadlessAuthError('CONFIG_BUSY', 'headless settings are being edited; retry shortly')
      }
      throw new HeadlessAuthError('WRITE_FAILED', 'headless settings could not be saved')
    }
  }

  return { status: async () => { const loaded = await current(); return summary(loaded.rows, loaded.state) }, check, configure }
}
