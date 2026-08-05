const MAP_SDK_LOAD_TIMEOUT_MS = 8000

let naverMapSdkPromise: Promise<void> | null = null
let naverMapPanoramaPromise: Promise<void> | null = null

interface NaverMapsNamespace {
  jsContentLoaded?: boolean
  onJSContentLoaded?: () => void
  Panorama?: unknown
}

interface NaverWindow extends Window {
  naver?: { maps?: NaverMapsNamespace }
}

export type NaverMapSubmodule = 'panorama'

interface NaverMapSdkOptions {
  submodules?: readonly NaverMapSubmodule[]
}

export function loadNaverMapSdk(ncpKeyId: string, options: NaverMapSdkOptions = {}): Promise<void> {
  if (typeof window === 'undefined')
    return Promise.reject(new Error('Naver Maps SDK is client-only'))

  const corePromise = loadNaverMapCore(ncpKeyId)
  if (!options.submodules?.includes('panorama')) return corePromise

  return corePromise.then(() => loadNaverMapPanorama())
}

function loadNaverMapCore(ncpKeyId: string): Promise<void> {
  const maps = getNaverMaps()
  if (maps?.jsContentLoaded) return Promise.resolve()
  if (naverMapSdkPromise) return naverMapSdkPromise

  naverMapSdkPromise = new Promise((resolve, reject) => {
    const src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(
      ncpKeyId,
    )}`
    const script = document.createElement('script')
    const timer = window.setTimeout(() => {
      reject(new Error('Naver Maps SDK load timed out'))
    }, MAP_SDK_LOAD_TIMEOUT_MS)

    const cleanup = () => {
      window.clearTimeout(timer)
      script.onload = null
      script.onerror = null
    }
    const resolveWhenReady = () => {
      const maps = getNaverMaps()
      if (!maps) {
        cleanup()
        reject(new Error('Naver Maps SDK did not initialize'))
        return
      }
      if (maps.jsContentLoaded) {
        cleanup()
        resolve()
        return
      }
      maps.onJSContentLoaded = () => {
        cleanup()
        resolve()
      }
    }

    script.async = true
    script.src = src
    script.onload = resolveWhenReady
    script.onerror = () => {
      cleanup()
      reject(new Error('Naver Maps SDK request failed'))
    }
    document.head.appendChild(script)
  })

  return naverMapSdkPromise
}

function loadNaverMapPanorama(): Promise<void> {
  const maps = getNaverMaps()
  if (!maps) return Promise.reject(new Error('Naver Maps SDK is not ready'))
  if ('Panorama' in maps) return Promise.resolve()
  if (naverMapPanoramaPromise) return naverMapPanoramaPromise

  const panoramaPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    const timer = window.setTimeout(() => {
      reject(new Error('Naver Maps panorama module load timed out'))
    }, MAP_SDK_LOAD_TIMEOUT_MS)

    const cleanup = () => {
      window.clearTimeout(timer)
      script.onload = null
      script.onerror = null
    }
    const resolveWhenReady = () => {
      if ('Panorama' in maps) {
        cleanup()
        resolve()
        return
      }
      cleanup()
      reject(new Error('Naver Maps panorama module did not initialize'))
    }

    script.async = true
    script.src = 'https://oapi.map.naver.com/openapi/v3/maps-panorama.js'
    script.onload = resolveWhenReady
    script.onerror = () => {
      cleanup()
      reject(new Error('Naver Maps panorama module request failed'))
    }
    document.head.appendChild(script)
  })

  naverMapPanoramaPromise = panoramaPromise.catch((error) => {
    naverMapPanoramaPromise = null
    throw error
  })

  return naverMapPanoramaPromise
}

function getNaverMaps(): NaverMapsNamespace | undefined {
  return (window as NaverWindow).naver?.maps
}
