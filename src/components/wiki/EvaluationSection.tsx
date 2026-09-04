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

/**
 * 웹 후기 분위기 — 히어로 「쉬움 점수」의 근거 블록. 「후기 종합」 섹션 안에 들어간다.
 *
 * 예전에는 「평가」라는 별도 섹션에서 이용자 별점 칸과 나란히 그렸다. 점수는 히어로에서
 * 이용자 후기·웹 후기를 합친 하나로 보여주기로 했고(2026-09-04), 여기는 그 점수가
 * 어떤 어조의 글에서 나왔는지만 보여준다.
 *
 * 별 아이콘도, `N/5` 숫자도 쓰지 않는다. AI가 글을 읽고 추정한 값이라 별점과 같은 모양으로
 * 그리면 사용자가 실제 평점으로 오해하고, 검색엔진 정책상으로도 위험하다.
 */
export function EvaluationSection({ sentiment }: { sentiment: WebSentiment | null }) {
  // 읽은 글이 0건이면 태그가 있어도 열지 않는다 — "0건을 읽고 분류"는 거짓 안내다
  if (sentiment === null || sentiment.count <= 0) return null

  const { good, neutral, bad } = sentiment.buckets
  const total = good + neutral + bad
  const showBars = sentiment.count >= MIN_SENTIMENT_COUNT && total > 0

  return (
    // 섹션 안의 하위 블록이다 — 카드를 씌우지 않고 헤어라인 하나로 위와 나눈다 (디자인 규칙 §4)
    <div className="mt-4 border-t border-zinc-100 pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="m-0 text-xs font-semibold text-muted-foreground">후기 분위기</p>
        <span className="text-[11px] text-faint">
          웹 후기 {sentiment.count.toLocaleString()}건의 어조를 분류한 값
        </span>
      </div>

      {showBars ? (
        <>
          <p className="mt-1.5 text-[15px] font-bold text-ink">{moodLabel(sentiment.average)}</p>
          <div className="mt-2.5 space-y-1.5">
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
        <p className="mt-1.5 text-sm text-muted-foreground">아직 분위기를 판단하기 어렵습니다</p>
      )}

      {sentiment.tags.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
            후기에서 자주 나온 말
          </p>
          <div className="flex flex-wrap gap-1.5">
            {sentiment.tags.map((tag) => (
              <span
                key={tag.key}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${TAG_CLASS[tag.polarity]}`}
              >
                {tag.label}
                <span className="ml-1 opacity-70">{tag.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
