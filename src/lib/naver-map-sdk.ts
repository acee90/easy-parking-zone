/**
 * 모바일 3G/혼잡 구간에서 8초는 정상 응답까지 잘라내기에 충분히 짧았다.
 * (실측: 9초에 도착한 SDK를 기다리지 못하고 지도가 에러로 떨어짐)
 */
const MAP_SDK_LOAD_TIMEOUT_MS = 15000

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

  const corePromise = new Promise<void>((resolve, reject) => {
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

  // 실패한 promise를 그대로 캐시하면 이후 모든 호출이 같은 rejection을 돌려받아
  // SPA 세션 내내 지도가 죽는다(스크립트 재요청조차 하지 않음). 패노라마 로더와 동일하게 비운다.
  naverMapSdkPromise = corePromise.catch((error) => {
    naverMapSdkPromise = null
    throw error
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
