/** Account connection and headless setup: a status pill in the dialog header with a settings popover. */
import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { configureHeadlessAuth, headlessAuthCheck, headlessAuthStatus, WslApiError } from './api.ts'
import type { HeadlessAuthCheck, HeadlessAuthState } from './api.ts'

interface HeadlessSignInProps {
  t: (key: string, params?: Record<string, unknown>) => string
}

type Connection = HeadlessAuthCheck['status'] | 'idle' | 'checking'

/** Feedback keys that report a finished action rather than a problem. */
const SUCCESS = new Set(['downloaded', 'saved', 'resetDone'])

const DOCS_URL = 'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#credentials'

function settingError(error: unknown): string {
  if (error instanceof WslApiError) {
    switch (error.code) {
      case 'CONFIG_CONFLICT': return 'conflict'
      case 'CONFIG_INVALID': return 'invalid'
      case 'CONFIG_BUSY': return 'busy'
    }
  }
  return 'saveFailed'
}

function downloadSettings(yaml: string): void {
  const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml;charset=utf-8' }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = 'headless-account.patch.yml'
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/** Only an authenticated account request can turn the connection indicator green. */
export function HeadlessSignIn({ t }: HeadlessSignInProps): React.ReactElement {
  const [connection, setConnection] = useState<Connection>('idle')
  const [reason, setReason] = useState('')
  const [scope, setScope] = useState<'once' | 'permanent'>('once')
  const [saved, setSaved] = useState<HeadlessAuthState | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState('')
  const [expanded, setExpanded] = useState(false)
  const generation = useRef(0)
  const anchor = useRef<HTMLDivElement>(null)
  const busy = loading || connection === 'checking' || saving

  useEffect(() => {
    let active = true
    void headlessAuthStatus().then(state => {
      if (!active) return
      setSaved(state)
      if (state.permanent) setScope('permanent')
    }).catch(() => { if (active) setFeedback('loadFailed') }).finally(() => { if (active) setLoading(false) })
    // One check per dialog open, so the header pill answers without opening the popover;
    // the popover's Check button stays for a re-check (e.g. right after signing in on desktop).
    void checkConnection()
    return () => { active = false; generation.current += 1 }
  }, [])

  // A press anywhere outside the pill and its popover folds the popover away.
  useEffect(() => {
    if (!expanded) return
    const outside = (event: MouseEvent): void => {
      if (anchor.current !== null && !anchor.current.contains(event.target as Node)) setExpanded(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [expanded])

  async function checkConnection(): Promise<void> {
    const request = ++generation.current
    setConnection('checking')
    setReason('')
    setFeedback('')
    try {
      const answer = await headlessAuthCheck()
      if (request !== generation.current) return
      setConnection(answer.status)
      setReason(answer.reason ?? '')
    } catch {
      if (request !== generation.current) return
      setConnection('failed')
      setReason('request-failed')
    }
  }

  async function applySettings(reset = false): Promise<void> {
    const request = ++generation.current
    setSaving(true)
    setFeedback('')
    try {
      const result = await configureHeadlessAuth(reset ? 'reset' : scope)
      if (request !== generation.current) return
      if (result.scope === 'once') {
        if (typeof result.yaml !== 'string' || result.yaml === '') throw new Error('missing overlay')
        downloadSettings(result.yaml)
      }
      setSaved(result)
      setFeedback(result.scope === 'once' ? 'downloaded' : result.scope === 'reset' ? 'resetDone' : 'saved')
      if (result.scope === 'reset') setScope('once')
    } catch (error) {
      if (request === generation.current) setFeedback(settingError(error))
    } finally {
      if (request === generation.current) setSaving(false)
    }
  }

  const statusKey = connection === 'failed' && reason === 'timeout' ? 'timeout' : connection
  const statusText = t(`auth.status.${statusKey}`)
  const tone = feedback === '' ? 'hint' : SUCCESS.has(feedback) ? 'success' : 'error'
  const hint = saved?.permanent && scope === 'permanent' ? 'auth.currentSaved' : scope === 'once' ? 'auth.onceHint' : 'auth.permanentHint'
  const pickScope = (next: 'once' | 'permanent'): void => { setScope(next); setFeedback('') }
  const escape = (event: React.KeyboardEvent): void => {
    // Escape folds the popover first; the dialog's own Escape must not also fire.
    if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false) }
  }

  return (
    <div className="dww-auth" ref={anchor} onKeyDown={escape}>
      <button
        type="button"
        className="dww-auth-chip"
        data-state={connection}
        title={statusText}
        aria-expanded={expanded}
        aria-haspopup="dialog"
        onClick={() => setExpanded(value => !value)}
      >
        <span className="dww-auth-dot" aria-hidden="true" />
        {t('auth.chip')}
        <span className="dww-auth-caret" aria-hidden="true">▾</span>
      </button>
      {expanded ? (
        <section className="dww-signin-notice" role="dialog" aria-label={t('auth.title')}>
          <div className="dww-auth-head">
            <span className="dww-auth-title">{t('auth.title')}</span>
            <a className="dww-help-link" href={DOCS_URL} target="_blank" rel="noreferrer">{t('auth.docs')}</a>
          </div>
          <div className="dww-auth-row">
            <div className="dww-auth-status" data-state={connection} role="status" aria-live="polite">
              <span className="dww-auth-dot" aria-hidden="true" />{statusText}
            </div>
            <button className="dww-check-btn dww-auth-check" type="button" title={t('auth.checkHint')} disabled={busy} onClick={() => { void checkConnection() }}>
              {t(connection === 'checking' ? 'auth.checking' : 'auth.check')}
            </button>
          </div>
          <div className="dww-auth-row">
            <fieldset className="dww-auth-scope" disabled={busy}>
              <legend className="dww-sr-only">{t('auth.scope')}</legend>
              <label><input type="radio" name="dww-auth-scope" value="once" checked={scope === 'once'} onChange={() => pickScope('once')} />{t('auth.once')}</label>
              <label><input type="radio" name="dww-auth-scope" value="permanent" checked={scope === 'permanent'} onChange={() => pickScope('permanent')} />{t('auth.permanent')}</label>
            </fieldset>
            <div className="dww-auth-actions">
              {saved?.managed && saved.canReset ? (
                <button className="dww-auth-reset" type="button" disabled={busy} onClick={() => { void applySettings(true) }}>{t('auth.reset')}</button>
              ) : null}
              <button className="dww-btn dww-btn--primary dww-auth-apply" type="button" disabled={busy || connection !== 'connected'} onClick={() => { void applySettings() }}>
                {t(saving ? 'auth.saving' : scope === 'once' ? 'auth.download' : 'auth.save')}
              </button>
            </div>
          </div>
          {feedback !== ''
            ? <p className="dww-auth-note dww-auth-feedback" data-tone={tone} role="status">{t(`auth.feedback.${feedback}`)}</p>
            : <p className="dww-auth-note" data-tone="hint">{t(hint)}</p>}
        </section>
      ) : null}
    </div>
  )
}
