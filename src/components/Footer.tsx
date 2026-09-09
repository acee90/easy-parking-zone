import { Link } from '@tanstack/react-router'
import { PARKING_REGIONS } from '@/lib/parking-regions'

export function Footer() {
  return (
    <footer className="bg-zinc-800 py-8 pb-16 text-zinc-400 md:py-10 md:pb-10">
      <div className="mx-auto max-w-6xl px-4">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-4 md:gap-8">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <img src="/favicon-32.png" alt="" className="size-6 rounded" />
              <span className="text-lg font-bold text-white">쉬운주차장</span>
            </div>
            <p className="text-sm leading-relaxed text-zinc-400">
              전국 주차장 난이도·요금·운영시간을 실제 방문 데이터로 비교합니다.
            </p>
          </div>

          {/* 지역 허브 17개는 크롤러의 주요 진입 경로다. 링크를 줄이지 말고 배치만 좁힌다. */}
          <div className="md:col-span-2">
            <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-200">
              지역별 주차장
            </h3>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-zinc-400">
              {PARKING_REGIONS.map((region) => (
                <Link
                  key={region.label}
                  to="/wiki/region/$region"
                  params={{ region: region.label }}
                  className="transition-colors hover:text-white hover:underline"
                >
                  {region.label} 주차장
                </Link>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-200">
              서비스
            </h3>
            <ul className="space-y-1.5 text-sm text-zinc-400">
              <li>
                <Link to="/" className="transition-colors hover:text-white hover:underline">
                  주차장 지도
                </Link>
              </li>
              <li>
                <Link to="/wiki" className="transition-colors hover:text-white hover:underline">
                  주차장 둘러보기
                </Link>
              </li>
              <li>
                <Link to="/wiki/all" className="transition-colors hover:text-white hover:underline">
                  전체 주차장 목록
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-6 border-t border-zinc-700 pt-4">
          <div className="flex flex-col items-center justify-between gap-2 md:flex-row">
            <p className="text-xs text-zinc-500">
              © 2026 쉬운주차장. All rights reserved. 데이터 출처: 공공데이터포털
            </p>
            <div className="flex items-center gap-4 text-xs text-zinc-400">
              <Link to="/terms" className="transition-colors hover:text-white hover:underline">
                이용약관
              </Link>
              <Link to="/privacy" className="transition-colors hover:text-white hover:underline">
                개인정보처리방침
              </Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
