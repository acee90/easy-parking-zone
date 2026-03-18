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

function tmapUrl({ lat, lng, name }: NavTarget): string {
  const encoded = encodeURIComponent(name)
  return `tmap://route?goalname=${encoded}&goaly=${lat}&goalx=${lng}`
}

export function getNavOptions(target: NavTarget): NavOption[] {
  const mobile = isMobile()
  const options: NavOption[] = [
    { app: 'naver', label: '네이버지도', url: naverUrl(target, mobile) },
    { app: 'kakao', label: '카카오맵', url: kakaoUrl(target, mobile) },
  ]
  // 티맵은 공식 웹 길찾기 URL이 없으므로 모바일(앱 딥링크)에서만 표시
  if (mobile) {
    options.push({ app: 'tmap', label: '티맵', url: tmapUrl(target) })
  }
  return options
}
