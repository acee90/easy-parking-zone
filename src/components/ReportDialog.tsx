import { Flag, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createContentReport, getReportReasons, type ReportTargetType } from '@/server/reports'

interface ReportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetType: ReportTargetType
  targetId: number
  parkingLotId: string
}

export function ReportDialog({
  open,
  onOpenChange,
  targetType,
  targetId,
  parkingLotId,
}: ReportDialogProps) {
  const [reasons, setReasons] = useState<{ code: string; label: string }[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<'success' | 'duplicate' | 'error' | null>(null)

  useEffect(() => {
    if (open) {
      setSelected(null)
      setDetail('')
      setResult(null)
      getReportReasons({ data: { targetType } })
        .then(setReasons)
        .catch(() => setReasons([]))
    }
  }, [open, targetType])

  const handleSubmit = async () => {
    if (!selected) return
    setSubmitting(true)
    try {
      await createContentReport({
        data: {
          targetType,
          targetId,
          parkingLotId,
          reason: selected,
          detail: selected === 'other' ? detail : undefined,
        },
      })
      setResult('success')
    } catch (e) {
      const code = (e as { code?: string }).code
      const msg = e instanceof Error ? e.message : ''
      setResult(
        code === 'DUPLICATE_REPORT' || msg.includes('UNIQUE constraint') ? 'duplicate' : 'error',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const resultMessages = {
    success: '신고가 접수되었습니다. 검토 후 처리됩니다.',
    duplicate: '이미 신고한 콘텐츠입니다.',
    error: '신고 접수에 실패했습니다. 잠시 후 다시 시도해주세요.',
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Flag className="size-4 text-red-500" />
            신고하기
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="text-center py-4">
            <p
              className={`text-sm ${result === 'success' ? 'text-green-600' : result === 'duplicate' ? 'text-amber-600' : 'text-red-500'}`}
            >
              {resultMessages[result]}
            </p>
            <button
              onClick={() => onOpenChange(false)}
              className="mt-4 px-4 py-2 text-xs font-medium rounded-md bg-gray-100 hover:bg-gray-200 cursor-pointer"
            >
              닫기
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              {reasons.map(({ code, label }) => (
                <label
                  key={code}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                    selected === code ? 'bg-red-50 ring-1 ring-red-200' : 'hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={code}
                    checked={selected === code}
                    onChange={() => setSelected(code)}
                    className="accent-red-500"
                  />
                  <span className="text-xs">{label}</span>
                </label>
              ))}
            </div>

            {selected === 'other' && (
              <textarea
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                maxLength={200}
                rows={2}
                placeholder="신고 사유를 입력해주세요"
                className="w-full rounded-md border px-2.5 py-1.5 text-xs resize-none"
              />
            )}

            <button
              onClick={handleSubmit}
              disabled={
                !selected || submitting || (selected === 'other' && detail.trim().length < 2)
              }
              className="w-full rounded-md bg-red-500 py-2.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors flex items-center justify-center gap-1.5"
            >
              {submitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> 접수 중...
                </>
              ) : (
                '신고 접수'
              )}
            </button>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 신고 버튼 (인라인용) */
export function ReportButton({
  targetType,
  targetId,
  parkingLotId,
}: {
  targetType: ReportTargetType
  targetId: number
  parkingLotId: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        className="p-1 rounded-full hover:bg-gray-100 cursor-pointer text-gray-400 hover:text-red-400 transition-colors"
        title="신고"
      >
        <Flag className="size-3" />
      </button>
      <ReportDialog
        open={open}
        onOpenChange={setOpen}
        targetType={targetType}
        targetId={targetId}
        parkingLotId={parkingLotId}
      />
    </>
  )
}
