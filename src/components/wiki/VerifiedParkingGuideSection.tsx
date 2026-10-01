import { useState } from 'react'
import {
  estimateVerifiedFee,
  type VerifiedParkingGuide,
  verifiedGuidePath,
} from '@/lib/verified-parking-guides'

const DURATIONS = [30, 60, 120, 240, 360, 420]

export function VerifiedParkingGuideSection({ guide }: { guide: VerifiedParkingGuide }) {
  const [copyState, setCopyState] = useState('안내 링크 복사')
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`https://easy-parking.xyz${verifiedGuidePath(guide)}`)
      setCopyState('링크를 복사했습니다')
    } catch {
      setCopyState('주소창의 링크를 복사해 주세요')
    }
  }

  return (
    <section
      id="visit-guide"
      aria-labelledby="visit-guide-title"
      className="space-y-5 scroll-mt-16"
    >
      <div className="space-y-2">
        <h2 id="visit-guide-title" className="text-[17px] font-extrabold text-ink">
          방문 전 주차 안내
        </h2>
        <p className="text-[15px] font-semibold leading-relaxed">{guide.summary}</p>
        <p className="text-xs text-muted-foreground">
          공식 안내 확인 <time dateTime={guide.checkedAt}>{guide.checkedAt}</time> · 현장 방문
          후기가 아닌 공식 정보 기준 정리
        </p>
      </div>
      <div className="space-y-4">
        {guide.decisions.map((item) => (
          <div key={item.title}>
            <h3 className="mb-1 text-sm font-bold">{item.title}</h3>
            <p className="text-sm leading-relaxed text-ink-2">{item.text}</p>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm tabular-nums">
          <caption className="mb-2 text-left text-xs text-muted-foreground">
            할인 미적용 예상 요금 · 같은 날 입출차 기준
          </caption>
          <thead>
            <tr className="border-b border-zinc-200">
              <th className="py-2">주차 시간</th>
              <th className="py-2 text-right">예상 요금</th>
            </tr>
          </thead>
          <tbody>
            {DURATIONS.map((minutes) => (
              <tr key={minutes} className="border-b border-zinc-100">
                <th scope="row" className="py-2 font-normal">
                  {minutes < 60 ? `${minutes}분` : `${minutes / 60}시간`}
                </th>
                <td className="py-2 text-right">
                  {estimateVerifiedFee(guide, minutes)?.toLocaleString()}원
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        구매·시설 이용 할인, 운영일 및 현장 정책에 따라 실제 요금이 달라질 수 있습니다. 출발 전 공식
        안내를 확인하세요.
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
        <a
          href={guide.source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-4"
        >
          {guide.source.label} ↗
        </a>
        <button
          type="button"
          onClick={copyLink}
          className="cursor-pointer text-primary underline underline-offset-4"
          aria-live="polite"
        >
          {copyState}
        </button>
      </div>
    </section>
  )
}
