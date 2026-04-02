import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  type AdminReviewItem,
  adminDeleteReview,
  fetchRecentReviews,
  fetchReviewStats,
  type ReviewSource,
} from '@/server/admin'

export const Route = createFileRoute('/admin/reviews')({
  loader: async () => {
    const [reviewData, stats] = await Promise.all([
      fetchRecentReviews({ data: { page: 1, limit: 30, source: 'all' } }),
      fetchReviewStats(),
    ])
    return { reviewData, stats }
  },
  component: ReviewsPage,
})

const SOURCE_FILTERS: { value: ReviewSource; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'user', label: '유저 직접' },
  { value: 'clien', label: '클리앙' },
]

const SOURCE_BADGE: Record<string, { label: string; class: string }> = {
  user: { label: '유저', class: 'bg-blue-50 text-blue-700' },
  clien: { label: '클리앙', class: 'bg-orange-50 text-orange-700' },
}

function ReviewsPage() {
  const { reviewData, stats: initialStats } = Route.useLoaderData()
  const [reviews, setReviews] = useState<AdminReviewItem[]>(reviewData.items)
  const [stats, _setStats] = useState(initialStats)
  const [total, setTotal] = useState(reviewData.total)
  const [page, setPage] = useState(1)
  const [source, setSource] = useState<ReviewSource>('all')
  const [loading, setLoading] = useState(false)
  const limit = 30

  async function reload(newPage: number, newSource: ReviewSource) {
    setLoading(true)
    const res = await fetchRecentReviews({ data: { page: newPage, limit, source: newSource } })
    setReviews(res.items)
    setTotal(res.total)
    setLoading(false)
  }

  function handlePageChange(newPage: number) {
    setPage(newPage)
    reload(newPage, source)
  }

  function handleSourceChange(newSource: ReviewSource) {
    setSource(newSource)
    setPage(1)
    reload(1, newSource)
  }

  const totalPages = Math.ceil(total / limit)

  async function handleDelete(id: number) {
    if (!confirm('이 리뷰를 삭제하시겠습니까?')) return
    await adminDeleteReview({ data: { reviewId: id } })
    setReviews((prev) => prev.filter((r) => r.id !== id))
    setTotal((t) => t - 1)
  }

  function formatDate(iso: string) {
    const d = new Date(iso.includes('Z') ? iso : `${iso}Z`)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 60) return `${diffMin}분 전`
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return `${diffHr}시간 전`
    const diffDay = Math.floor(diffHr / 24)
    if (diffDay < 7) return `${diffDay}일 전`
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
  }

  function getPageNumbers(current: number, total: number): (number | 'ellipsis')[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
    const pages: (number | 'ellipsis')[] = [1]
    if (current > 3) pages.push('ellipsis')
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
      pages.push(i)
    }
    if (current < total - 2) pages.push('ellipsis')
    pages.push(total)
    return pages
  }

  return (
    <>
      {/* Stats */}
      <div className="flex flex-wrap gap-3 mb-6">
        <StatCard label="전체 리뷰" value={stats.total} highlight />
        {Object.entries(stats.counts)
          .sort(([, a], [, b]) => b - a)
          .map(([src, cnt]) => (
            <StatCard key={src} label={SOURCE_BADGE[src]?.label ?? src} value={cnt} />
          ))}
      </div>

      {/* Source Filter */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {SOURCE_FILTERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => handleSourceChange(value)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              source === value
                ? 'bg-gray-900 text-white'
                : 'bg-white text-gray-700 border hover:bg-gray-50'
            }`}
          >
            {label}
            {value !== 'all' && <span className="ml-1 opacity-60">{stats.counts[value] ?? 0}</span>}
          </button>
        ))}
        <span className="ml-auto text-sm text-muted-foreground">{total}건</span>
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">로딩 중...</div>
      ) : reviews.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">리뷰가 없습니다.</div>
      ) : (
        <div className="rounded-lg border bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">작성일</TableHead>
                <TableHead className="w-20">출처</TableHead>
                <TableHead>주차장</TableHead>
                <TableHead className="w-16 text-center">평점</TableHead>
                <TableHead>내용</TableHead>
                <TableHead className="w-24">작성자</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {reviews.map((r) => {
                const badge = SOURCE_BADGE[r.source] ?? {
                  label: r.source,
                  class: 'bg-gray-50 text-gray-600',
                }
                return (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(r.createdAt)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${badge.class}`}
                      >
                        {badge.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs font-medium max-w-[160px] truncate">
                      {r.parkingLotName}
                    </TableCell>
                    <TableCell className="text-center text-sm">
                      {r.overallScore != null ? (
                        r.overallScore
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[300px]">
                      <p className="text-xs text-muted-foreground truncate">
                        {r.comment || <span className="italic opacity-40">없음</span>}
                      </p>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.authorName}</TableCell>
                    <TableCell>
                      <button
                        onClick={() => handleDelete(r.id)}
                        className="px-2 py-1 rounded text-xs text-red-500 hover:bg-red-50 hover:text-red-700 transition-colors whitespace-nowrap"
                      >
                        삭제
                      </button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            전체 {total}건 중 {(page - 1) * limit + 1}-{Math.min(page * limit, total)}건
          </p>
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => handlePageChange(Math.max(1, page - 1))}
                  className={page === 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                />
              </PaginationItem>
              {getPageNumbers(page, totalPages).map((p, i) =>
                p === 'ellipsis' ? (
                  <PaginationItem key={`e-${i}`}>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={p}>
                    <PaginationLink
                      isActive={p === page}
                      onClick={() => handlePageChange(p)}
                      className="cursor-pointer"
                    >
                      {p}
                    </PaginationLink>
                  </PaginationItem>
                ),
              )}
              <PaginationItem>
                <PaginationNext
                  onClick={() => handlePageChange(Math.min(totalPages, page + 1))}
                  className={
                    page === totalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'
                  }
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </>
  )
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${highlight ? 'bg-blue-50 border-blue-200' : 'bg-white'}`}
    >
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-lg font-bold">{value}</p>
    </div>
  )
}
