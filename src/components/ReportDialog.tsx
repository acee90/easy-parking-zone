import { useState, useEffect } from "react";
import { Flag, X, Loader2 } from "lucide-react";
import { createContentReport, getReportReasons, type ReportTargetType } from "@/server/reports";

interface ReportDialogProps {
  open: boolean;
  onClose: () => void;
  targetType: ReportTargetType;
  targetId: number;
  parkingLotId: string;
}

export function ReportDialog({
  open,
  onClose,
  targetType,
  targetId,
  parkingLotId,
}: ReportDialogProps) {
  const [reasons, setReasons] = useState<{ code: string; label: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"success" | "duplicate" | "error" | null>(null);

  useEffect(() => {
    if (open) {
      setSelected(null);
      setDetail("");
      setResult(null);
      getReportReasons({ data: { targetType } })
        .then(setReasons)
        .catch(() => setReasons([]));
    }
  }, [open, targetType]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await createContentReport({
        data: {
          targetType,
          targetId,
          parkingLotId,
          reason: selected,
          detail: selected === "other" ? detail : undefined,
        },
      });
      setResult("success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setResult(msg.includes("이미 신고") ? "duplicate" : "error");
    } finally {
      setSubmitting(false);
    }
  };

  const resultMessages = {
    success: "신고가 접수되었습니다. 검토 후 처리됩니다.",
    duplicate: "이미 신고한 콘텐츠입니다.",
    error: "신고 접수에 실패했습니다. 잠시 후 다시 시도해주세요.",
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-white rounded-t-2xl sm:rounded-2xl p-5 pb-8 sm:pb-5 animate-in slide-in-from-bottom-4 sm:slide-in-from-bottom-0 duration-200">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Flag className="size-4 text-red-500" />
            <h3 className="text-sm font-semibold">신고하기</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-gray-100 cursor-pointer"
          >
            <X className="size-4" />
          </button>
        </div>

        {result ? (
          <div className="text-center py-4">
            <p className={`text-sm ${result === "success" ? "text-green-600" : result === "duplicate" ? "text-amber-600" : "text-red-500"}`}>
              {resultMessages[result]}
            </p>
            <button
              onClick={onClose}
              className="mt-4 px-4 py-2 text-xs font-medium rounded-md bg-gray-100 hover:bg-gray-200 cursor-pointer"
            >
              닫기
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-1.5 mb-4">
              {reasons.map(({ code, label }) => (
                <label
                  key={code}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                    selected === code
                      ? "bg-red-50 ring-1 ring-red-200"
                      : "hover:bg-gray-50"
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

            {selected === "other" && (
              <textarea
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                maxLength={200}
                rows={2}
                placeholder="신고 사유를 입력해주세요"
                className="w-full rounded-md border px-2.5 py-1.5 text-xs resize-none mb-4"
              />
            )}

            <button
              onClick={handleSubmit}
              disabled={!selected || submitting || (selected === "other" && detail.trim().length < 2)}
              className="w-full rounded-md bg-red-500 py-2.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors flex items-center justify-center gap-1.5"
            >
              {submitting ? (
                <><Loader2 className="size-3.5 animate-spin" /> 접수 중...</>
              ) : (
                "신고 접수"
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** 신고 버튼 (인라인용) */
export function ReportButton({
  targetType,
  targetId,
  parkingLotId,
}: {
  targetType: ReportTargetType;
  targetId: number;
  parkingLotId: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className="p-1 rounded-full hover:bg-gray-100 cursor-pointer text-gray-400 hover:text-red-400 transition-colors"
        title="신고"
      >
        <Flag className="size-3" />
      </button>
      <ReportDialog
        open={open}
        onClose={() => setOpen(false)}
        targetType={targetType}
        targetId={targetId}
        parkingLotId={parkingLotId}
      />
    </>
  );
}
