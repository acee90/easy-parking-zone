const MAP_SDK_LOAD_TIMEOUT_MS = 8000

let naverMapSdkPromise: Promise<void> | null = null

export function loadNaverMapSdk(ncpKeyId: string): Promise<void> {
  if (typeof window === 'undefined')
    return Promise.reject(new Error('Naver Maps SDK is client-only'))
  if (window.naver?.maps) return Promise.resolve()
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
      const maps = window.naver?.maps
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
