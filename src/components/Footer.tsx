import { Link } from '@tanstack/react-router'

const REGIONS = [
  { label: '서울', prefix: '서울' },
  { label: '경기', prefix: '경기' },
  { label: '부산', prefix: '부산' },
  { label: '인천', prefix: '인천' },
  { label: '대구', prefix: '대구' },
  { label: '대전', prefix: '대전' },
  { label: '광주', prefix: '광주' },
  { label: '울산', prefix: '울산' },
  { label: '제주', prefix: '제주' },
]

export function Footer() {
  return (
    <footer className="bg-zinc-800 py-12 pb-24 text-zinc-400 md:pb-12">
      <div className="mx-auto max-w-6xl px-4">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-4">
          <div className="space-y-4 md:col-span-2">
            <div className="flex items-center gap-2">
              <img src="/favicon-32.png" alt="" className="size-6 rounded" />
              <span className="text-lg font-bold text-white">쉬운주차장</span>
            </div>
            <p className="text-sm leading-relaxed text-zinc-400">
              주차하기 전에 한 번만 확인하세요. 전국 주차장 난이도, 요금, 운영시간을 한눈에 비교할
              수 있는 서비스를 지향합니다. 실제 방문 데이터와 AI 요약을 통해 초보 운전자도 안심하고
              방문할 수 있는 세상을 만듭니다.
            </p>
          </div>

          <div>
            <h3 className="mb-4 text-sm font-bold uppercase tracking-wider text-zinc-200">
              지역별 주차장
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-zinc-400">
              {REGIONS.map((region) => (
                <Link
                  key={region.prefix}
                  to="/wiki/all"
                  search={{ region: region.prefix }}
                  className="transition-colors hover:text-white hover:underline"
                >
                  {region.label} 주차장
                </Link>
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-4 text-sm font-bold uppercase tracking-wider text-zinc-200">
              서비스
            </h3>
            <ul className="space-y-2 text-sm text-zinc-400">
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

        <div className="mt-12 border-t border-zinc-700 pt-8">
          <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
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
