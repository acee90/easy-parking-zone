/** 길찾기 딥링크 생성 유틸리티 */

interface NavTarget {
  lat: number
  lng: number
  name: string
}

export type NavApp = 'naver' | 'kakao' | 'tmap'

export interface NavOption {
  app: NavApp
  label: string
  url: string
}

function isMobile(): boolean {
  return typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
}

function naverUrl({ lat, lng, name }: NavTarget, mobile: boolean): string {
  const encoded = encodeURIComponent(name)
  if (mobile) {
    return `nmap://navigation?dlat=${lat}&dlng=${lng}&dname=${encoded}`
  }
  return `https://map.naver.com/v5/directions/-/${lng},${lat},${encoded}/-/car`
}

function kakaoUrl({ lat, lng, name }: NavTarget, mobile: boolean): string {
  const encoded = encodeURIComponent(name)
  if (mobile) {
    return `kakaomap://route?ep=${lat},${lng}&eName=${encoded}`
  }
  return `https://map.kakao.com/link/to/${encoded},${lat},${lng}`
}

function tmapUrl({ lat, lng, name }: NavTarget, mobile: boolean): string {
  const encoded = encodeURIComponent(name)
  if (mobile) {
    return `tmap://route?goalname=${encoded}&goaly=${lat}&goalx=${lng}`
  }
  return `https://map.kakao.com/link/to/${encoded},${lat},${lng}`
}

export function getNavOptions(target: NavTarget): NavOption[] {
  const mobile = isMobile()
  return [
    { app: 'naver', label: '네이버지도', url: naverUrl(target, mobile) },
    { app: 'kakao', label: '카카오맵', url: kakaoUrl(target, mobile) },
    { app: 'tmap', label: '티맵', url: tmapUrl(target, mobile) },
  ]
}
