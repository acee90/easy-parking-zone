import { useState, useCallback, useEffect } from 'react'
import { DEFAULT_CENTER } from '@/lib/geo-utils'

interface GeolocationState {
  lat: number
  lng: number
  loading: boolean
  error: string | null
  located: boolean
}

export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    lat: DEFAULT_CENTER.lat,
    lng: DEFAULT_CENTER.lng,
    loading: false,
    error: null,
    located: false,
  })
  const [initializing, setInitializing] = useState(true)

  // Manual location request (MyLocationButton)
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setState((prev) => ({ ...prev, loading: false, error: '위치 서비스를 지원하지 않는 브라우저입니다.' }))
      return
    }

    setState((prev) => ({ ...prev, loading: true, error: null, located: false }))

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setState({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          loading: false,
          error: null,
          located: true,
        })
      },
      (err) => {
        setState((prev) => ({
          ...prev,
          loading: false,
          located: false,
          error:
            err.code === err.PERMISSION_DENIED
              ? '위치 권한이 거부되었습니다.'
              : '위치를 가져올 수 없습니다.',
        }))
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    )
  }, [])

  // On mount: silently get position only if permission is already granted (no dialog)
  useEffect(() => {
    if (!navigator.permissions || !navigator.geolocation) {
      setInitializing(false)
      return
    }

    navigator.permissions
      .query({ name: 'geolocation' })
      .then((status) => {
        if (status.state === 'granted') {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              setState({
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                loading: false,
                error: null,
                located: true,
              })
              setInitializing(false)
            },
            () => {
              setInitializing(false)
            },
            { enableHighAccuracy: false, timeout: 2000, maximumAge: 300000 }
          )
        } else {
          setInitializing(false)
        }
      })
      .catch(() => {
        setInitializing(false)
      })
  }, [])

  return { ...state, initializing, requestLocation }
}
