/** Account connection and headless setup beside the optional WSL username. */
import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { configureHeadlessAuth, headlessAuthCheck, headlessAuthStatus, WslApiError } from './api.ts'
import type { HeadlessAuthCheck, HeadlessAuthState } from './api.ts'

interface HeadlessSignInProps {
  t: (key: string, params?: Record<string, unknown>) => string
}

type Connection = HeadlessAuthCheck['status'] | 'idle' | 'checking'

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
  const generation = useRef(0)
  const busy = loading || connection === 'checking' || saving

  useEffect(() => {
    let active = true
    void headlessAuthStatus().then(state => {
      if (!active) return
      setSaved(state)
      if (state.permanent) setScope('permanent')
    }).catch(() => { if (active) setFeedback('loadFailed') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; generation.current += 1 }
  }, [])

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
  return (
    <section className="dww-signin-notice" aria-label={t('auth.title')}>
      <h3 className="dww-signin-title">{t('auth.title')}</h3>
      <div className="dww-auth-check-row">
        <div className="dww-auth-status" data-state={connection} role="status" aria-live="polite">
          <span className="dww-auth-dot" aria-hidden="true" />{t(`auth.status.${statusKey}`)}
        </div>
        <button className="dww-btn dww-auth-check" type="button" disabled={busy} onClick={() => { void checkConnection() }}>
          {t(connection === 'checking' ? 'auth.checking' : 'auth.check')}
        </button>
      </div>
      <p className="dww-signin-lead">{t('auth.checkHint')}</p>
      <fieldset className="dww-auth-scope" disabled={busy}>
        <legend>{t('auth.scope')}</legend>
        <label><input type="radio" name="dww-auth-scope" value="once" checked={scope === 'once'} onChange={() => { setScope('once'); setFeedback('') }} />{t('auth.once')}</label>
        <label><input type="radio" name="dww-auth-scope" value="permanent" checked={scope === 'permanent'} onChange={() => { setScope('permanent'); setFeedback('') }} />{t('auth.permanent')}</label>
      </fieldset>
      <p className="dww-signin-lead">{t(scope === 'once' ? 'auth.onceHint' : 'auth.permanentHint')}</p>
      {saved?.permanent ? <p className="dww-signin-lead">{t('auth.currentSaved')}</p> : null}
      <div className="dww-auth-actions">
        <button className="dww-btn dww-btn--primary dww-auth-apply" type="button" disabled={busy || connection !== 'connected'} onClick={() => { void applySettings() }}>
          {t(saving ? 'auth.saving' : scope === 'once' ? 'auth.download' : 'auth.save')}
        </button>
        {saved?.managed && saved.canReset ? (
          <button className="dww-btn dww-auth-reset" type="button" disabled={busy} onClick={() => { void applySettings(true) }}>{t('auth.reset')}</button>
        ) : null}
      </div>
      {feedback !== '' ? <p className="dww-auth-feedback" role="status">{t(`auth.feedback.${feedback}`)}</p> : null}
      <a className="dww-help-link" href="https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#credentials" target="_blank" rel="noreferrer">{t('auth.docs')}</a>
    </section>
  )
}
