import { createFileRoute } from '@tanstack/react-router'
import { Check, ExternalLink, X } from 'lucide-react'
import { useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { FIELD_GROUP_LABELS, type FieldGroup, parseFieldPayload } from '@/lib/lot-field-groups'
import { makeParkingSlug } from '@/lib/slug'
import {
  type AdminFieldEditItem,
  type EditReviewStatus,
  fetchFieldEdits,
  reviewFieldEdit,
} from '@/server/admin-field-edits'

export const Route = createFileRoute('/admin/field-edits')({
  loader: async () => fetchFieldEdits({ data: { status: 'pending', page: 1 } }),
  component: AdminFieldEditsPage,
})

const TABS: Array<{ status: EditReviewStatus; label: string }> = [
  { status: 'pending', label: '승인 대기' },
  { status: 'applied', label: '즉시 반영 중' },
  { status: 'verified', label: '확인됨' },
  { status: 'rejected', label: '반려' },
  { status: 'superseded', label: '덮어써짐' },
]

/** payload JSON 을 사람이 읽는 한 줄로. 관리자는 이 줄만 보고 pick 을 누른다 */
function describePayload(group: FieldGroup, json: string): string {
  const p = parseFieldPayload(group, json)
  if (!p) return '(읽을 수 없는 값)'
  if (group === 'spaces') return `${(p as { totalSpaces: number }).totalSpaces.toLocaleString()}면`
  if (group === 'hours') {
    const h = p as {
      weekday: { start: string; end: string }
      saturday: { start: string; end: string }
    }
    return `평일 ${h.weekday.start}-${h.weekday.end} · 토 ${h.saturday.start}-${h.saturday.end}`
  }
  const f = p as {
    isFree: boolean
    baseTime: number
    baseFee: number
    extraTime: number
    extraFee: number
    dailyMax: number | null
  }
  if (f.isFree) return '무료'
  const parts = [`기본 ${f.baseTime}분 ${f.baseFee.toLocaleString()}원`]
  if (f.extraTime > 0) parts.push(`추가 ${f.extraTime}분 ${f.extraFee.toLocaleString()}원`)
  if (f.dailyMax) parts.push(`1일 최대 ${f.dailyMax.toLocaleString()}원`)
  return parts.join(' · ')
}

function AdminFieldEditsPage() {
  const initial = Route.useLoaderData()
  const [status, setStatus] = useState<EditReviewStatus>('pending')
  const [items, setItems] = useState<AdminFieldEditItem[]>(initial.items)
  const [counts, setCounts] = useState<Record<string, number>>(initial.counts)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load(next: EditReviewStatus) {
    setStatus(next)
    const res = await fetchFieldEdits({ data: { status: next, page: 1 } })
    setItems(res.items)
    setCounts(res.counts)
  }

  async function act(id: number, action: 'pick' | 'reject') {
    setBusyId(id)
    setError(null)
    try {
      await reviewFieldEdit({ data: { id, action } })
      await load(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : '처리에 실패했습니다')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="p-6">
      <h1 className="mb-1 text-xl font-bold">기본정보 제보 관리</h1>
      <p className="mb-4 text-sm text-gray-500">
        「확인」을 누르면 그 값이 확정되고, 이후 같은 항목의 제보는 즉시 반영되지 않고 이 큐로
        들어옵니다. 「반려」한 값이 즉시 반영 중이었다면 그 칸은 다시 「정보 없음」이 됩니다.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            onClick={() => load(tab.status)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
              status === tab.status ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-600 border'
            }`}
          >
            {tab.label}
            <span className="ml-1.5 tabular-nums opacity-70">{counts[tab.status] ?? 0}</span>
          </button>
        ))}
      </div>

      {error && <p className="mb-3 text-sm font-semibold text-red-600">{error}</p>}

      <div className="rounded-lg border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>주차장</TableHead>
              <TableHead>항목</TableHead>
              <TableHead>제보값</TableHead>
              <TableHead>근거</TableHead>
              <TableHead>제출</TableHead>
              <TableHead className="text-right">처리</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-gray-400">
                  해당하는 제보가 없습니다
                </TableCell>
              </TableRow>
            )}
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="max-w-[220px]">
                  <a
                    href={`/wiki/${encodeURI(makeParkingSlug(item.lotName ?? item.parkingLotId, item.parkingLotId))}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium hover:underline"
                  >
                    <span className="truncate">{item.lotName ?? item.parkingLotId}</span>
                    <ExternalLink className="size-3 shrink-0 opacity-50" />
                  </a>
                  <div className="text-xs text-gray-400">{item.parkingLotId}</div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {FIELD_GROUP_LABELS[item.fieldGroup]}
                  {item.baseHadValue === 1 && (
                    <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700">
                      덮어쓰기
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {describePayload(item.fieldGroup, item.payload)}
                </TableCell>
                <TableCell className="max-w-[200px] truncate text-xs text-gray-500">
                  {item.sourceNote ?? '—'}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-gray-500">
                  {item.createdAt.slice(0, 16).replace('T', ' ')}
                  <div>{item.authorUserId ? '로그인' : '비로그인'}</div>
                </TableCell>
                <TableCell className="text-right">
                  {item.status !== 'verified' && item.status !== 'rejected' && (
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => act(item.id, 'pick')}
                        className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        <Check className="size-3" />
                        확인
                      </button>
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => act(item.id, 'reject')}
                        className="inline-flex items-center gap-1 rounded bg-zinc-200 px-2 py-1 text-xs font-semibold text-zinc-700 disabled:opacity-50"
                      >
                        <X className="size-3" />
                        반려
                      </button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
