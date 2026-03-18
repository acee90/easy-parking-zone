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
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
}

function naverUrl({ lat, lng, name }: NavTarget): string {
  const encoded = encodeURIComponent(name)
  if (isMobile()) {
    return `nmap://navigation?dlat=${lat}&dlng=${lng}&dname=${encoded}&appname=com.easyparkingzone`
  }
  return `https://map.naver.com/v5/directions/-/${lng},${lat},${encoded}/-/car`
}

function kakaoUrl({ lat, lng, name }: NavTarget): string {
  const encoded = encodeURIComponent(name)
  if (isMobile()) {
    return `kakaomap://route?ep=${lat},${lng}&eName=${encoded}`
  }
  return `https://map.kakao.com/link/to/${encoded},${lat},${lng}`
}

function tmapUrl({ lat, lng, name }: NavTarget): string {
  const encoded = encodeURIComponent(name)
  if (isMobile()) {
    return `tmap://route?goalname=${encoded}&goaly=${lat}&goalx=${lng}`
  }
  // 티맵은 웹 길찾기 URL이 없으므로 앱 스토어로 폴백
  return `https://tmap.life/navigate?goalname=${encoded}&goaly=${lat}&goalx=${lng}`
}

export function getNavOptions(target: NavTarget): NavOption[] {
  return [
    { app: 'naver', label: '네이버지도', url: naverUrl(target) },
    { app: 'kakao', label: '카카오맵', url: kakaoUrl(target) },
    { app: 'tmap', label: '티맵', url: tmapUrl(target) },
  ]
}
