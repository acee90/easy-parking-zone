import { Star } from 'lucide-react'
import { DividerGrid } from '@/components/wiki/SectionShell'
export interface WebSentiment {
  /** 1~5 스케일 웹 후기 평균 */
  average: number
  /** 분류에 실제로 쓰인 유효 후기 수 */
  count: number
  /** >=4 / 3이상 4미만 / 3미만 */
  buckets: { good: number; neutral: number; bad: number }
  tags: Array<{ key: string; label: string; polarity: 'good' | 'bad' | 'neutral'; count: number }>
}

/**
 * 분위기 막대를 그리기 위한 최소 후기 수.
 * 1~2건의 평균은 평점이라고 부를 수 없어서, 그 아래는 분포를 아예 그리지 않는다.
 */
const MIN_SENTIMENT_COUNT = 3

const BUCKET_ROWS = [
  { key: 'good', label: '좋았다', bar: 'bg-green-500' },
  { key: 'neutral', label: '보통', bar: 'bg-zinc-300' },
  { key: 'bad', label: '아쉬웠다', bar: 'bg-amber-500' },
] as const

const TAG_CLASS = {
  good: 'bg-green-50 text-green-700',
  bad: 'bg-amber-50 text-amber-700',
  neutral: 'bg-zinc-100 text-zinc-600',
} as const

/** 웹 후기 평균을 문장으로 바꾼다 — 숫자를 그대로 노출하면 별점으로 오해된다 */
function moodLabel(average: number): string {
  if (average >= 4.0) return '좋다는 평이 많음'
  if (average >= 3.4) return '무난하다는 평'
  return '아쉽다는 평이 있음'
}

/** 이용자 별점 칸 — 값이 없으면 별을 0개로 그리지 않고 안내 문구만 남긴다 */
function UserScorePanel({ score, count }: { score: number | null; count: number }) {
  return (
    <div className="px-3.5 py-[13px]">
      <p className="text-xs font-semibold text-muted-foreground">이용자 별점</p>
      {score === null || count === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">아직 남겨진 평가가 없습니다</p>
      ) : (
        <>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star
                  key={n}
                  className={`size-4 ${
                    Math.round(score) >= n ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-300'
                  }`}
                />
              ))}
            </div>
            <span className="text-2xl font-black leading-none tabular-nums text-ink">
              {score.toFixed(1)}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-faint">
            직접 주차해 본 이용자 {count.toLocaleString()}명
          </p>
        </>
      )}
    </div>
  )
}

/**
 * 후기 어조 칸.
 *
 * 별 아이콘도, `N/5` 숫자도 쓰지 않는다. AI가 글을 읽고 추정한 값이라 별점과 같은 모양으로
 * 그리면 사용자가 실제 평점으로 오해하고, 검색엔진 정책상으로도 위험하다.
 */
function SentimentPanel({ sentiment }: { sentiment: WebSentiment }) {
  const { good, neutral, bad } = sentiment.buckets
  const total = good + neutral + bad
  const showBars = sentiment.count >= MIN_SENTIMENT_COUNT && total > 0

  return (
    <div className="px-3.5 py-[13px]">
      <p className="text-xs font-semibold text-muted-foreground">후기 분위기</p>

      {showBars ? (
        <>
          <p className="mt-2 text-lg font-bold">{moodLabel(sentiment.average)}</p>
          <div className="mt-3 space-y-1.5">
            {BUCKET_ROWS.map((row) => {
              const value = sentiment.buckets[row.key]
              return (
                <div key={row.key} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-xs text-muted-foreground">{row.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-hair-2">
                    <div
                      className={`h-full rounded-full ${row.bar}`}
                      style={{ width: `${Math.round((value / total) * 100)}%` }}
                    />
                  </div>
                  <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {value}건
                  </span>
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">아직 분위기를 판단하기 어렵습니다</p>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        후기 {sentiment.count.toLocaleString()}건의 어조를 분류한 값입니다
      </p>
    </div>
  )
}

/**
 * 후기 종합 — 이용자 후기와 웹 글을 **하나로** 정리해 보여준다.
 *
 * 예전에는 「웹 후기 분위기」와 「후기 종합」이 다른 섹션이었다. 읽는 사람에게
 * 두 출처를 구분해 보여줄 이유가 없다 — 알고 싶은 건 "여기 주차가 어떤가" 하나다.
 * 출처 구분은 내부(집계 가중치·근거 배분)에서만 하고, 화면에서는 합친다.
 *
 * 산문 요약이 본문이고, 분위기 막대와 자주 나온 말은 그 요약을 뒷받침하는 지표다.
 * 이용자 별점 숫자는 히어로 지표가 정본이라 여기서 다시 그리지 않는다.
 */
export function EvaluationSection({
  userScore,
  userCount,
  sentiment,
}: {
  /** 실사용자(is_seed=0) 후기 평균 */
  userScore: number | null
  userCount: number
  sentiment: WebSentiment | null
}) {
  // 읽은 글이 0건이면 태그가 있어도 분위기 칸을 열지 않는다 — "0건을 읽고 분류"는 거짓 안내다
  const hasSentiment = sentiment !== null && sentiment.count > 0

  // 이용자 별점은 **히어로 지표가 정본**이다. 여기서 또 그리면 한 화면에 같은 숫자가
  // 두 번 나온다 — 히어로는 숫자, 여기는 별과 분포로 같은 값을 다르게 보여준다 (시안 구성).
  const hasUser = userScore !== null && userCount > 0
  if (!hasUser && !hasSentiment) return null

  return (
    <section className="flex flex-col">
      <div className="mb-[11px] flex flex-wrap items-center justify-between gap-2.5">
        <h2 className="m-0 text-[17px] font-extrabold tracking-[-0.015em] text-ink">평가</h2>
      </div>
      <p className="-mt-1 mb-[11px] text-[11.5px] text-faint">
        직접 남긴 별점과 후기 전반의 어조를 함께 봅니다
      </p>

      {/* 시안 `.eval` — 두 칸을 선 하나로 나눈 한 덩어리 */}
      <DividerGrid cols={hasSentiment ? 2 : 1} className="rounded-[10px]">
        {/* 별점이 없어도 칸은 남긴다 — "아직 없다"가 곧 후기를 남겨달라는 안내다 */}
        <UserScorePanel score={userScore} count={userCount} />
        {hasSentiment && <SentimentPanel sentiment={sentiment} />}
      </DividerGrid>

      {hasSentiment && sentiment.tags.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">후기에서 자주 나온 말</p>
          <div className="flex flex-wrap gap-1.5">
            {sentiment.tags.map((tag) => (
              <span
                key={tag.key}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${TAG_CLASS[tag.polarity]}`}
              >
                {tag.label}
                <span className="ml-1 tabular-nums opacity-70">{tag.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
