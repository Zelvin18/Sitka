import type { SitkaApi } from './index'

declare global {
  interface Window {
    sitka: SitkaApi
  }
}

export {}
