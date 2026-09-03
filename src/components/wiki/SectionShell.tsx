import type { ReactNode } from 'react'

/**
 * 상세페이지 v2 섹션 껍데기 — 시안(artifact 5fafe247)의 `.sec-h` 대응
 *
 * 시안의 조형 언어는 **카드가 아니다**. 섹션마다 흰 카드를 씌우고 p-6 을 주면
 * "기존 디자인에 섹션만 추가한" 모양이 된다. 시안은 제목 한 줄 + 1px 헤어라인으로
 * 나뉜 흰 칸들이고, 그래서 밀도가 높고 위아래가 하나의 문서로 읽힌다.
 *
 * 치수는 시안 CSS 그대로다 — 제목 15.5px/800, 부제 11.5px, 아래 여백 11px.
 * 시안은 900px 문서 안에 실제 크기로 그려져 있어 키워 옮기면 안 된다.
 */
export function SectionShell({
  title,
  sub,
  note,
  children,
  id,
}: {
  title: string
  /** 제목 오른쪽 끝에 붙는 짧은 수치·범위 설명 */
  sub?: string
  /** 제목 아래 한 줄 안내 */
  note?: string
  children: ReactNode
  id?: string
}) {
  return (
    <section id={id} className="flex flex-col">
      <div className="mb-[11px] flex flex-wrap items-center justify-between gap-2.5">
        <h2 className="m-0 text-[17px] font-extrabold tracking-[-0.015em] text-ink">{title}</h2>
        {sub && <span className="text-[11.5px] tabular-nums text-muted-foreground">{sub}</span>}
      </div>
      {note && <p className="-mt-1 mb-[11px] text-[11.5px] text-faint">{note}</p>}
      {children}
    </section>
  )
}

/** 열 수 → Tailwind 클래스. 좁은 화면에서는 2열까지만 유지한다 */
const COLUMNS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-2 md:grid-cols-3',
  4: 'grid-cols-2 md:grid-cols-4',
}

/**
 * 칸을 나눈 지표 묶음.
 *
 * ⚠️ 회색 면을 깔고 1px 틈으로 나누지 않는다 — 흰 시트 위에 표면을 하나 더 얹는 꼴이고
 *    (디자인 규칙 §5), 그 위에 글씨를 얹으면 읽기 어려워진다(§2). 나누는 건 **선**이다.
 *
 * ⚠️ `divide-x divide-y` 도 쓰지 않는다. Tailwind 의 divide 는 **마지막 자식을 뺀 전부**에
 *    오른쪽·아래 선을 준다. 4칸 한 줄이면 3칸 밑에만 가로선이 생겨 **끊긴 선**이 남고,
 *    모바일에서 2열로 접히면 줄바꿈 지점에 선이 겹친다 (2026-09-03 실측).
 *    각 칸에 왼쪽·위 선을 주고 바깥쪽 한 줄을 잘라내면 어떤 열 수에서도 깨끗하다.
 */
export function DividerGrid({
  cols = 1,
  children,
  className = '',
  ...rest
}: {
  cols?: number
  children: ReactNode
  className?: string
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`overflow-hidden ${className}`} {...rest}>
      <div
        className={`-ml-px -mt-px grid [&>*]:border-l [&>*]:border-t [&>*]:border-zinc-100 ${COLUMNS[cols] ?? COLUMNS[1]}`}
      >
        {children}
      </div>
    </div>
  )
}

/** 나뉜 칸 하나 — 표면색을 갖지 않는다 (시트의 흰색을 그대로 쓴다) */
export function DividerCell({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`px-3.5 py-[13px] ${className}`}>{children}</div>
}
