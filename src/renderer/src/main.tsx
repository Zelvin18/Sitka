import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { installBrowserMockIfNeeded } from './lib/browserMock'
import { applyCachedAppearance } from './lib/prefs'

applyCachedAppearance()

function render(): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

// On the website the app code loads in parallel with the cloud backend and
// renders the moment the backend is installed. Elsewhere it renders at once.
const ready = (window as unknown as { sitkaReady?: Promise<void> }).sitkaReady
if (ready) {
  void ready.then(render)
} else {
  installBrowserMockIfNeeded()
  render()
}
