import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  fetchContentReports,
  fetchReportStats,
  resolveReport,
  type AdminReportItem,
  type ReportStatus,
  type ReportTargetFilter,
} from "@/server/admin-reports";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
} from "@/components/ui/pagination";
import { ExternalLink, Check, X } from "lucide-react";

export const Route = createFileRoute("/admin/reports")({
  loader: async () => {
    const [reportData, stats] = await Promise.all([
      fetchContentReports({ data: { status: "pending", page: 1 } }),
      fetchReportStats(),
    ]);
    return { reportData, stats };
  },
  component: AdminReportsPage,
});

const TARGET_TYPE_LABELS: Record<string, string> = {
  web_source: "웹소스",
  media: "미디어",
  review: "리뷰",
};

const REASON_LABELS: Record<string, string> = {
  wrong_link: "잘못된 연결",
  advertisement: "광고",
  inaccurate: "부정확",
  broken_link: "링크 깨짐",
  duplicate: "중복",
  inappropriate: "부적절",
  fake_review: "허위 리뷰",
  abusive: "욕설/비방",
  spam: "스팸",
  wrong_parking: "잘못된 주차장",
  other: "기타",
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: "대기", color: "bg-amber-100 text-amber-700" },
  resolved: { label: "승인", color: "bg-green-100 text-green-700" },
  dismissed: { label: "기각", color: "bg-gray-100 text-gray-500" },
};

function AdminReportsPage() {
  const { reportData: initialData, stats: initialStats } = Route.useLoaderData();
  const [items, setItems] = useState<AdminReportItem[]>(initialData.items);
  const [total, setTotal] = useState(initialData.total);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ReportStatus>("pending");
  const [targetType, setTargetType] = useState<ReportTargetFilter>("all");
  const [stats, setStats] = useState(initialStats);
  const [processing, setProcessing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async (p = page, s = status, t = targetType) => {
    const [data, newStats] = await Promise.all([
      fetchContentReports({ data: { status: s, targetType: t, page: p } }),
      fetchReportStats(),
    ]);
    setItems(data.items);
    setTotal(data.total);
    setPage(p);
    setStats(newStats);
  };

  const handleStatusChange = (s: ReportStatus) => {
    setStatus(s);
    reload(1, s, targetType);
  };

  const handleTargetTypeChange = (t: ReportTargetFilter) => {
    setTargetType(t);
    reload(1, status, t);
  };

  const handleResolve = async (reportId: number, action: "resolve" | "dismiss") => {
    setProcessing(reportId);
    setError(null);
    try {
      await resolveReport({ data: { reportId, action } });
      await reload();
    } catch {
      setError("처리 중 오류가 발생했습니다. 다시 시도해주세요.");
    } finally {
      setProcessing(null);
    }
  };

  const totalPages = Math.ceil(total / 30);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold">콘텐츠 신고 관리</h2>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "전체", value: stats.total, color: "text-gray-900" },
          { label: "대기중", value: stats.counts.pending ?? 0, color: "text-amber-600" },
          { label: "승인", value: stats.counts.resolved ?? 0, color: "text-green-600" },
          { label: "기각", value: stats.counts.dismissed ?? 0, color: "text-gray-500" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-lg border p-4 text-center">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-4 items-center">
        <div className="flex gap-1 bg-white rounded-lg border p-1">
          {(["pending", "resolved", "dismissed", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => handleStatusChange(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                status === s
                  ? "bg-gray-900 text-white"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {s === "all" ? "전체" : STATUS_LABELS[s].label}
              {s === "pending" && (stats.counts.pending ?? 0) > 0 && (
                <span className="ml-1 text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5">
                  {stats.counts.pending}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-white rounded-lg border p-1">
          {(["all", "web_source", "media", "review"] as const).map((t) => (
            <button
              key={t}
              onClick={() => handleTargetTypeChange(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                targetType === t
                  ? "bg-gray-900 text-white"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {t === "all" ? "전체" : TARGET_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">유형</TableHead>
              <TableHead className="w-24">사유</TableHead>
              <TableHead>대상 콘텐츠</TableHead>
              <TableHead className="w-32">주차장</TableHead>
              <TableHead className="w-20">상태</TableHead>
              <TableHead className="w-28">접수일</TableHead>
              <TableHead className="w-24">액션</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  신고 내역이 없습니다
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">
                      {TARGET_TYPE_LABELS[item.targetType] ?? item.targetType}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {REASON_LABELS[item.reason] ?? item.reason}
                    {item.detail && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
                        {item.detail}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-xs max-w-[200px]">
                    <p className="line-clamp-1">{item.targetTitle ?? "(제목 없음)"}</p>
                    {item.targetUrl && (
                      <a
                        href={item.targetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:underline inline-flex items-center gap-0.5 mt-0.5"
                      >
                        원본 보기 <ExternalLink className="size-2.5" />
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.parkingLotName}
                  </TableCell>
                  <TableCell>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_LABELS[item.status]?.color ?? ""}`}>
                      {STATUS_LABELS[item.status]?.label ?? item.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.createdAt?.slice(0, 10)}
                  </TableCell>
                  <TableCell>
                    {item.status === "pending" && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleResolve(item.id, "resolve")}
                          disabled={processing === item.id}
                          className="p-1.5 rounded-md bg-green-50 text-green-600 hover:bg-green-100 cursor-pointer disabled:opacity-50"
                          title="승인 (콘텐츠 숨김)"
                        >
                          <Check className="size-3.5" />
                        </button>
                        <button
                          onClick={() => handleResolve(item.id, "dismiss")}
                          disabled={processing === item.id}
                          className="p-1.5 rounded-md bg-gray-50 text-gray-400 hover:bg-gray-100 cursor-pointer disabled:opacity-50"
                          title="기각"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <Pagination>
          <PaginationContent>
            {page > 1 && (
              <PaginationItem>
                <PaginationPrevious onClick={() => reload(page - 1)} className="cursor-pointer" />
              </PaginationItem>
            )}
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              const p = page <= 3 ? i + 1 : page - 2 + i;
              if (p > totalPages) return null;
              return (
                <PaginationItem key={p}>
                  <PaginationLink
                    onClick={() => reload(p)}
                    isActive={p === page}
                    className="cursor-pointer"
                  >
                    {p}
                  </PaginationLink>
                </PaginationItem>
              );
            })}
            {page < totalPages && (
              <PaginationItem>
                <PaginationNext onClick={() => reload(page + 1)} className="cursor-pointer" />
              </PaginationItem>
            )}
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
