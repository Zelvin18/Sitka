import React from 'react'
import { Mark } from '../lib/icons'

interface State {
  error: Error | null
}

/**
 * A crash anywhere below used to unmount the whole app and leave a blank
 * screen with nothing to go on. Now the page stays, says what went wrong in
 * plain words (with the technical line underneath for a screenshot), and
 * offers a way back.
 */
export default class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Sitca: the page crashed', error, info.componentStack)
    // the owners' dashboard lists crashes people actually saw
    const report = (window as unknown as { sitkaReportError?: (p: string, m: string, s?: string) => void })
      .sitkaReportError
    report?.(location.hash || location.pathname, `${error.name}: ${error.message}`, error.stack || info.componentStack || undefined)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <div className="crash-card">
          <Mark size={28} />
          <h2>Something went wrong on this page</h2>
          <p>
            Sitca hit a problem it could not recover from. Your recordings and sessions are safe.
            Go back to the start, or reload the page.
          </p>
          <div className="crash-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                try {
                  sessionStorage.clear()
                } catch {
                  /* ignore */
                }
                location.hash = ''
                location.reload()
              }}
            >
              Back to the start
            </button>
            <button className="btn btn-ghost" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
          <div className="crash-detail">
            {error.name}: {error.message}
          </div>
        </div>
      </div>
    )
  }
}
