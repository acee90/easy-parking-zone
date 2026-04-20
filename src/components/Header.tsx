import { Link } from '@tanstack/react-router'
import { Car, ChevronDown, Compass, LogIn, LogOut, Map as MapIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SearchBar } from '@/components/SearchBar'
import { authClient } from '@/lib/auth-client'
import type { ParkingLot } from '@/types/parking'

interface SiteStats {
  parkingLots: number
  reviews: number
  mediaPosts: number
}

interface HeaderProps {
  active?: 'map' | 'wiki'
  onSearchSelect?: (lot: ParkingLot) => void
  onPlaceSelect?: (coords: { lat: number; lng: number }) => void
  siteStats?: SiteStats
}

function LoginModal({ onClose }: { onClose: () => void }) {
  const handleSocial = (provider: 'kakao' | 'naver' | 'google') => {
    authClient.signIn.social({ provider, callbackURL: '/' })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl p-6 w-80 space-y-3 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-center mb-4">로그인</h2>
        <button
          onClick={() => handleSocial('kakao')}
          className="w-full rounded-lg py-2.5 text-sm font-medium bg-[#FEE500] text-[#191919] hover:bg-[#FDD835] cursor-pointer transition-colors"
        >
          카카오로 계속하기
        </button>
        <button
          onClick={() => handleSocial('naver')}
          className="w-full rounded-lg py-2.5 text-sm font-medium bg-[#03C75A] text-white hover:bg-[#02b351] cursor-pointer transition-colors"
        >
          네이버로 계속하기
        </button>
        <button
          onClick={() => handleSocial('google')}
          className="w-full rounded-lg py-2.5 text-sm font-medium bg-white text-gray-700 border hover:bg-gray-50 cursor-pointer transition-colors"
        >
          구글로 계속하기
        </button>
        <p className="text-xs text-muted-foreground text-center pt-2">
          비회원도 리뷰 작성이 가능합니다
        </p>
      </div>
    </div>
  )
}

function UserMenu() {
  const { data: session } = authClient.useSession()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!session?.user) return null

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 cursor-pointer rounded-md px-2 py-1 hover:bg-gray-100 transition-colors"
      >
        {session.user.image ? (
          <img src={session.user.image} alt="" className="size-6 rounded-full" />
        ) : (
          <div className="size-6 rounded-full bg-blue-100 flex items-center justify-center text-xs font-medium text-blue-600">
            {(session.user.name ?? 'U')[0]}
          </div>
        )}
        <span className="text-xs hidden sm:inline">{session.user.name}</span>
        <ChevronDown className="size-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-36 rounded-lg border bg-white shadow-lg py-1 z-50">
          <button
            onClick={() => {
              authClient.signOut()
              setOpen(false)
            }}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-gray-50 cursor-pointer"
          >
            <LogOut className="size-3.5" />
            로그아웃
          </button>
        </div>
      )}
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}천`
  return n.toLocaleString()
}

const navItemBase =
  'inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-sm font-medium transition-colors'
const navActive = `${navItemBase} bg-gray-100 text-foreground`
const navInactive = `${navItemBase} text-muted-foreground hover:text-foreground hover:bg-gray-50`

export function Header({ active = 'map', onSearchSelect, onPlaceSelect, siteStats }: HeaderProps) {
  const { data: session } = authClient.useSession()
  const [showLogin, setShowLogin] = useState(false)

  return (
    <>
      <header className="shrink-0 flex items-center gap-3 border-b bg-white px-4 py-2.5 z-30">
        <Link to="/" className="flex items-center gap-2 shrink-0">
          <Car className="size-5 text-blue-500" />
          <span className="font-bold text-base hidden sm:inline">쉬운주차장</span>
        </Link>
        <nav className="flex items-center gap-1">
          {active === 'map' ? (
            <span className={navActive}>
              <MapIcon className="size-3.5" />
              지도
            </span>
          ) : (
            <Link to="/" className={navInactive}>
              <MapIcon className="size-3.5" />
              지도
            </Link>
          )}
          {active === 'wiki' ? (
            <span className={navActive}>
              <Compass className="size-3.5" />
              둘러보기
            </span>
          ) : (
            <Link to="/wiki" className={navInactive}>
              <Compass className="size-3.5" />
              둘러보기
            </Link>
          )}
        </nav>
        {onSearchSelect && <SearchBar onSelect={onSearchSelect} onPlaceSelect={onPlaceSelect} />}
        {siteStats && (
          <div className="hidden md:flex items-center gap-3 text-xs text-muted-foreground shrink-0">
            <span className="w-px h-4 bg-border" />
            <span>
              주차장{' '}
              <strong className="text-foreground">{formatCount(siteStats.parkingLots)}</strong>
            </span>
            <span>
              리뷰 <strong className="text-foreground">{formatCount(siteStats.reviews)}</strong>
            </span>
            <span>
              영상/포스팅{' '}
              <strong className="text-foreground">{formatCount(siteStats.mediaPosts)}</strong>
            </span>
          </div>
        )}
        <div className="flex-1" />
        {session?.user ? (
          <UserMenu />
        ) : (
          <button
            onClick={() => setShowLogin(true)}
            className="flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          >
            <LogIn className="size-4" />
            <span className="hidden sm:inline">로그인</span>
          </button>
        )}
      </header>
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
    </>
  )
}
