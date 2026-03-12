import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import {
  fetchSignals,
  fetchSignalStats,
  fetchWebSources,
  fetchWebSourceStats,
  adminDeleteWebSource,
  tagSignal,
  removeLotFromSignal,
  addLotToSignal,
  searchParkingLots,
  fetchUnmatched,
  fetchUnmatchedStats,
  resolveUnmatched,
  ignoreUnmatched,
  type SignalItem,
  type WebSourceItem,
  type WebSourceType,
  type UnmatchedItem,
  type UnmatchedStatus,
} from "@/server/admin";

const WS_SOURCE_FILTERS: { value: WebSourceType; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "naver_blog", label: "블로그" },
  { value: "naver_cafe", label: "카페" },
  { value: "poi", label: "POI" },
  { value: "youtube_comment", label: "유튜브" },
  { value: "naver_place", label: "플레이스" },
];

const WS_SOURCE_BADGE: Record<string, { label: string; class: string }> = {
  naver_blog: { label: "블로그", class: "bg-green-50 text-green-700" },
  naver_cafe: { label: "카페", class: "bg-emerald-50 text-emerald-700" },
  poi: { label: "POI", class: "bg-purple-50 text-purple-700" },
  youtube_comment: { label: "유튜브", class: "bg-red-50 text-red-700" },
  naver_place: { label: "플레이스", class: "bg-teal-50 text-teal-700" },
};

type Tab = "signals" | "web-sources" | "unmatched";

export const Route = createFileRoute("/admin/web-sources")({
  loader: async () => {
    const [signalData, signalStats, wsData, wsStats, unmatchedData, unmatchedStats] = await Promise.all([
      fetchSignals({ data: { status: "pending", page: 1, limit: 50 } }),
      fetchSignalStats(),
      fetchWebSources({ data: { page: 1, limit: 30, source: "all" } }),
      fetchWebSourceStats(),
      fetchUnmatched({ data: { status: "pending", page: 1, limit: 50 } }),
      fetchUnmatchedStats(),
    ]);
    return { signalData, signalStats, wsData, wsStats, unmatchedData, unmatchedStats };
  },
  component: WebSourcesPage,
});

function WebSourcesPage() {
  const [tab, setTab] = useState<Tab>("signals");
  const { unmatchedStats } = Route.useLoaderData();

  return (
    <>
      <div className="flex gap-1 mb-6 border-b">
        {([
          ["signals", "크롤링 카페글 검수"],
          ["web-sources", "관심지점 주변 주차장"],
          ["unmatched", `POI 매칭 실패${unmatchedStats.pending > 0 ? ` (${unmatchedStats.pending})` : ""}`],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value as Tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === value
                ? "border-gray-900 text-gray-900"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "signals" ? <SignalsSection /> : tab === "web-sources" ? <WebSourcesSection /> : <UnmatchedSection />}
    </>
  );
}

// ============================================================
// 시그널 검수 섹션
// ============================================================

function SignalsSection() {
  const { signalData, signalStats: initialStats } = Route.useLoaderData();
  const [stats, setStats] = useState(initialStats);
  const [signals, setSignals] = useState<SignalItem[]>(signalData.items);
  const [total, setTotal] = useState(signalData.total);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<
    "pending" | "tagged" | "irrelevant" | "all"
  >("pending");
  const [lotSearch, setLotSearch] = useState("");
  const [loading, setLoading] = useState(false);

  async function reload(newStatus: typeof statusFilter, newLotSearch: string, newPage: number) {
    setLoading(true);
    const [res, s] = await Promise.all([
      fetchSignals({
        data: {
          status: newStatus,
          lotSearch: newLotSearch || undefined,
          page: newPage,
          limit: 50,
        },
      }),
      fetchSignalStats(),
    ]);
    setSignals(res.items);
    setTotal(res.total);
    setStats(s);
    setLoading(false);
  }

  async function handleTag(signalId: number, score: number | null) {
    await tagSignal({ data: { signalId, humanScore: score } });
    if (statusFilter === "pending" && score !== null) {
      setSignals((prev) => prev.filter((s) => s.id !== signalId));
      setTotal((t) => t - 1);
    } else {
      setSignals((prev) =>
        prev.map((s) =>
          s.id === signalId ? { ...s, humanScore: score } : s
        )
      );
    }
    fetchSignalStats().then(setStats);
  }

  async function handleRemoveLot(signalId: number, lotId: string) {
    await removeLotFromSignal({ data: { signalId, parkingLotId: lotId } });
    setSignals((prev) =>
      prev.map((s) =>
        s.id === signalId
          ? { ...s, lots: s.lots.filter((l) => l.parkingLotId !== lotId) }
          : s
      )
    );
  }

  async function handleAddLot(signalId: number, lotId: string) {
    const res = await addLotToSignal({ data: { signalId, parkingLotId: lotId } });
    setSignals((prev) =>
      prev.map((s) => {
        if (s.id !== signalId) return s;
        if (s.lots.some((l) => l.parkingLotId === lotId)) return s;
        return { ...s, lots: [...s.lots, res.lot] };
      })
    );
  }

  const totalPages = Math.ceil(total / 50);

  return (
    <>
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard label="전체 시그널" value={stats.total} />
          <StatCard label="미검수" value={stats.pending} highlight />
          <StatCard label="검수완료" value={stats.tagged} color="green" />
          <StatCard label="무관 처리" value={stats.irrelevant} color="gray" />
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {(
          [
            ["pending", "미검수"],
            ["tagged", "검수완료"],
            ["irrelevant", "무관"],
            ["all", "전체"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => {
              setStatusFilter(value);
              setPage(1);
              reload(value, lotSearch, 1);
            }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === value
                ? "bg-gray-900 text-white"
                : "bg-white text-gray-700 border hover:bg-gray-50"
            }`}
          >
            {label}
          </button>
        ))}
        <input
          type="text"
          placeholder="주차장 검색..."
          value={lotSearch}
          onChange={(e) => {
            const val = e.target.value;
            setLotSearch(val);
            setPage(1);
            reload(statusFilter, val, 1);
          }}
          className="ml-auto px-3 py-1.5 border rounded-md text-sm w-48"
        />
        <span className="text-sm text-gray-500">{total}건</span>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">로딩 중...</div>
      ) : signals.length === 0 ? (
        <div className="text-center py-12 text-gray-500">데이터가 없습니다.</div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-left">
                  <th className="px-4 py-3 font-medium text-gray-600 w-56">관련 주차장</th>
                  <th className="px-4 py-3 font-medium text-gray-600">언급 스니펫</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-56">카페 제목</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-16 text-center">AI</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-56 text-center">액션</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <SignalRow
                    key={s.id}
                    signal={s}
                    onTag={handleTag}
                    onRemoveLot={handleRemoveLot}
                    onAddLot={handleAddLot}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          <button
            onClick={() => { const p = Math.max(1, page - 1); setPage(p); reload(statusFilter, lotSearch, p); }}
            disabled={page === 1}
            className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
          >이전</button>
          <span className="px-3 py-1.5 text-sm text-gray-600">{page} / {totalPages}</span>
          <button
            onClick={() => { const p = Math.min(totalPages, page + 1); setPage(p); reload(statusFilter, lotSearch, p); }}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
          >다음</button>
        </div>
      )}
    </>
  );
}

// ============================================================
// 웹 소스 목록 섹션
// ============================================================

function WebSourcesSection() {
  const { wsData, wsStats: initialStats } = Route.useLoaderData();
  const [stats, setStats] = useState(initialStats);
  const [items, setItems] = useState<WebSourceItem[]>(wsData.items);
  const [total, setTotal] = useState(wsData.total);
  const [page, setPage] = useState(1);
  const [source, setSource] = useState<WebSourceType>("all");
  const [loading, setLoading] = useState(false);

  async function reload(newSource: WebSourceType, newPage: number) {
    setLoading(true);
    const res = await fetchWebSources({ data: { page: newPage, limit: 30, source: newSource } });
    setItems(res.items);
    setTotal(res.total);
    setLoading(false);
  }

  async function handleDelete(id: number) {
    if (!confirm("이 웹 소스를 삭제하시겠습니까?")) return;
    await adminDeleteWebSource({ data: { id } });
    setItems((prev) => prev.filter((r) => r.id !== id));
    setTotal((t) => t - 1);
    const s = await fetchWebSourceStats();
    setStats(s);
  }

  const limit = 30;
  const totalPages = Math.ceil(total / limit);

  return (
    <>
      <div className="flex flex-wrap gap-3 mb-6">
        <StatCard label="전체 웹 소스" value={stats.total} highlight />
        {Object.entries(stats.counts)
          .sort(([, a], [, b]) => b - a)
          .map(([src, cnt]) => (
            <StatCard key={src} label={WS_SOURCE_BADGE[src]?.label ?? src} value={cnt} />
          ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {WS_SOURCE_FILTERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => { setSource(value); setPage(1); reload(value, 1); }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              source === value
                ? "bg-gray-900 text-white"
                : "bg-white text-gray-700 border hover:bg-gray-50"
            }`}
          >
            {label}
            {value !== "all" && (
              <span className="ml-1 opacity-60">{stats.counts[value] ?? 0}</span>
            )}
          </button>
        ))}
        <span className="ml-auto text-sm text-gray-500">{total}건</span>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">로딩 중...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-gray-500">데이터가 없습니다.</div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-left">
                  <th className="px-4 py-3 font-medium text-gray-600 w-28">수집일</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-20">출처</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-40">주차장</th>
                  <th className="px-4 py-3 font-medium text-gray-600">내용</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-24">작성자</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-14" />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const badge = WS_SOURCE_BADGE[r.source] ?? { label: r.source, class: "bg-gray-50 text-gray-600" };
                  return (
                    <tr key={r.id} className="border-b hover:bg-gray-50/50">
                      <td className="px-4 py-3 text-xs text-gray-500">{formatDate(r.crawledAt)}</td>
                      <td className="px-4 py-3">
                        <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${badge.class}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs font-medium truncate max-w-[160px]">{r.parkingLotName}</td>
                      <td className="px-4 py-3 max-w-[300px]">
                        {r.title && <p className="text-xs font-medium text-gray-800 truncate">{r.title}</p>}
                        <p className="text-xs text-gray-500 truncate">{r.content || "-"}</p>
                        {r.sourceUrl && (
                          <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer"
                            className="text-[11px] text-blue-500 hover:underline truncate block">
                            원본 링크
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{r.author ?? "-"}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleDelete(r.id)}
                          className="px-2 py-1 rounded text-xs text-red-500 hover:bg-red-50 hover:text-red-700 transition-colors whitespace-nowrap"
                        >삭제</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          <button
            onClick={() => { const p = Math.max(1, page - 1); setPage(p); reload(source, p); }}
            disabled={page === 1}
            className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
          >이전</button>
          <span className="px-3 py-1.5 text-sm text-gray-600">{page} / {totalPages}</span>
          <button
            onClick={() => { const p = Math.min(totalPages, page + 1); setPage(p); reload(source, p); }}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
          >다음</button>
        </div>
      )}
    </>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso.includes("Z") ? iso : iso + "Z");
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}일 전`;
  return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

// --- Sub-components ---

function StatCard({
  label,
  value,
  highlight,
  color,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
  color?: "green" | "gray";
}) {
  const colorClass =
    color === "green"
      ? "text-green-600"
      : color === "gray"
        ? "text-gray-400"
        : "";

  return (
    <div
      className={`rounded-lg border px-4 py-3 ${highlight ? "bg-blue-50 border-blue-200" : "bg-white"}`}
    >
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-lg font-bold ${colorClass}`}>{value}</p>
    </div>
  );
}

const SCORE_BUTTONS = [
  { score: 0, label: "❌", title: "무관", style: "bg-gray-50 text-gray-500 hover:bg-gray-100" },
  { score: 1, label: "💀💀", title: "매우 어려움", style: "bg-red-100 text-red-800 hover:bg-red-200" },
  { score: 2, label: "💀", title: "어려움", style: "bg-red-50 text-red-700 hover:bg-red-100" },
  { score: 3, label: "😐", title: "보통", style: "bg-yellow-50 text-yellow-700 hover:bg-yellow-100" },
  { score: 4, label: "🙂", title: "쉬움", style: "bg-green-50 text-green-700 hover:bg-green-100" },
  { score: 5, label: "😊", title: "매우 쉬움", style: "bg-green-100 text-green-800 hover:bg-green-200" },
] as const;

function scoreLabel(score: number): string {
  return SCORE_BUTTONS.find((b) => b.score === score)?.label ?? "?";
}

function SignalRow({
  signal: s,
  onTag,
  onRemoveLot,
  onAddLot,
}: {
  signal: SignalItem;
  onTag: (id: number, score: number | null) => void;
  onRemoveLot: (id: number, lotId: string) => void;
  onAddLot: (id: number, lotId: string) => void;
}) {
  const [addingLot, setAddingLot] = useState(false);

  const aiIcon =
    s.aiSentiment === "positive"
      ? "👍"
      : s.aiSentiment === "negative"
        ? "👎"
        : "➖";

  return (
    <tr className="border-b hover:bg-gray-50/50 align-top">
      {/* 관련 주차장 (태그) */}
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {s.lots.map((lot) => (
            <span
              key={lot.parkingLotId}
              className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-xs max-w-[200px]"
              title={`${lot.name}\n${lot.address}`}
            >
              <span className="truncate">{lot.name}</span>
              <button
                onClick={() => onRemoveLot(s.id, lot.parkingLotId)}
                className="text-blue-300 hover:text-red-500 shrink-0 ml-0.5"
              >
                ×
              </button>
            </span>
          ))}
          {s.lots.length === 0 && (
            <span className="text-xs text-gray-400 italic">주차장 없음</span>
          )}
          <div className="relative">
            <button
              onClick={() => setAddingLot(!addingLot)}
              className="px-1.5 py-0.5 rounded-full border border-dashed text-xs text-gray-400 hover:text-blue-500 hover:border-blue-300"
            >
              +
            </button>
            {addingLot && (
              <LotSearchDropdown
                onSelect={(lotId) => {
                  onAddLot(s.id, lotId);
                  setAddingLot(false);
                }}
                onClose={() => setAddingLot(false)}
              />
            )}
          </div>
        </div>
      </td>

      {/* 언급 스니펫 */}
      <td className="px-4 py-3">
        <p className="text-xs text-gray-600 line-clamp-2">{s.snippet}</p>
      </td>

      {/* 카페 제목 */}
      <td className="px-4 py-3">
        <a
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline line-clamp-2"
        >
          {s.title}
        </a>
      </td>

      {/* AI */}
      <td className="px-4 py-3 text-center text-base">{aiIcon}</td>

      {/* 액션 */}
      <td className="px-4 py-3">
        {s.humanScore === null ? (
          <div className="flex gap-1 justify-center flex-wrap">
            {SCORE_BUTTONS.map((btn) => (
              <button
                key={btn.score}
                onClick={() => onTag(s.id, btn.score)}
                title={btn.title}
                className={`px-1.5 py-1 rounded text-xs transition-colors ${btn.style}`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex gap-1 justify-center items-center">
            <span className="text-sm">{scoreLabel(s.humanScore)}</span>
            <button
              onClick={() => onTag(s.id, null)}
              className="px-1.5 py-0.5 rounded text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-100"
            >
              되돌리기
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ============================================================
// POI 매칭 실패 섹션
// ============================================================

function UnmatchedSection() {
  const { unmatchedData, unmatchedStats: initialStats } = Route.useLoaderData();
  const [stats, setStats] = useState(initialStats);
  const [items, setItems] = useState<UnmatchedItem[]>(unmatchedData.items);
  const [total, setTotal] = useState(unmatchedData.total);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<UnmatchedStatus>("pending");
  const [loading, setLoading] = useState(false);

  async function reload(newStatus: UnmatchedStatus, newPage: number) {
    setLoading(true);
    const [res, s] = await Promise.all([
      fetchUnmatched({ data: { status: newStatus, page: newPage, limit: 50 } }),
      fetchUnmatchedStats(),
    ]);
    setItems(res.items);
    setTotal(res.total);
    setStats(s);
    setLoading(false);
  }

  async function handleIgnore(id: number) {
    await ignoreUnmatched({ data: { id } });
    if (statusFilter === "pending") {
      setItems((prev) => prev.filter((item) => item.id !== id));
      setTotal((t) => t - 1);
    } else {
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: "ignored" } : item)));
    }
    fetchUnmatchedStats().then(setStats);
  }

  async function handleResolve(id: number, lotId: string) {
    await resolveUnmatched({ data: { id, parkingLotId: lotId } });
    if (statusFilter === "pending") {
      setItems((prev) => prev.filter((item) => item.id !== id));
      setTotal((t) => t - 1);
    } else {
      reload(statusFilter, page);
    }
    fetchUnmatchedStats().then(setStats);
  }

  const totalPages = Math.ceil(total / 50);

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="전체" value={stats.total} />
        <StatCard label="미처리" value={stats.pending} highlight />
        <StatCard label="매칭완료" value={stats.resolved} color="green" />
        <StatCard label="무시" value={stats.ignored} color="gray" />
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {([
          ["pending", "미처리"],
          ["resolved", "매칭완료"],
          ["ignored", "무시"],
          ["all", "전체"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            onClick={() => { setStatusFilter(value); setPage(1); reload(value, 1); }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === value
                ? "bg-gray-900 text-white"
                : "bg-white text-gray-700 border hover:bg-gray-50"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-sm text-gray-500">{total}건</span>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">로딩 중...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-gray-500">데이터가 없습니다.</div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-left">
                  <th className="px-4 py-3 font-medium text-gray-600 w-40">POI 이름</th>
                  <th className="px-4 py-3 font-medium text-gray-600">추출된 주차장명</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-28">카테고리</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-20">상태</th>
                  <th className="px-4 py-3 font-medium text-gray-600 w-64 text-center">액션</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <UnmatchedRow
                    key={item.id}
                    item={item}
                    onIgnore={handleIgnore}
                    onResolve={handleResolve}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-4">
          <button
            onClick={() => { const p = Math.max(1, page - 1); setPage(p); reload(statusFilter, p); }}
            disabled={page === 1}
            className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
          >이전</button>
          <span className="px-3 py-1.5 text-sm text-gray-600">{page} / {totalPages}</span>
          <button
            onClick={() => { const p = Math.min(totalPages, page + 1); setPage(p); reload(statusFilter, p); }}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
          >다음</button>
        </div>
      )}
    </>
  );
}

function UnmatchedRow({
  item,
  onIgnore,
  onResolve,
}: {
  item: UnmatchedItem;
  onIgnore: (id: number) => void;
  onResolve: (id: number, lotId: string) => void;
}) {
  const [linking, setLinking] = useState(false);

  const statusBadge = item.status === "resolved"
    ? { label: "매칭완료", class: "bg-green-50 text-green-700" }
    : item.status === "ignored"
      ? { label: "무시", class: "bg-gray-50 text-gray-500" }
      : { label: "미처리", class: "bg-yellow-50 text-yellow-700" };

  return (
    <tr className="border-b hover:bg-gray-50/50 align-top">
      <td className="px-4 py-3">
        <p className="text-xs font-medium">{item.poiName}</p>
        <p className="text-[11px] text-gray-400">{item.poiLat.toFixed(4)}, {item.poiLng.toFixed(4)}</p>
      </td>
      <td className="px-4 py-3">
        <p className="text-xs font-medium text-gray-800">{item.lotName}</p>
        {item.resolvedLotName && (
          <p className="text-[11px] text-green-600 mt-0.5">→ {item.resolvedLotName}</p>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-gray-500">{item.category ?? "-"}</span>
      </td>
      <td className="px-4 py-3">
        <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${statusBadge.class}`}>
          {statusBadge.label}
        </span>
      </td>
      <td className="px-4 py-3">
        {item.status === "pending" ? (
          <div className="flex gap-1 justify-center items-center">
            <div className="relative">
              <button
                onClick={() => setLinking(!linking)}
                className="px-2 py-1 rounded text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
              >
                주차장 연결
              </button>
              {linking && (
                <LotSearchDropdown
                  onSelect={(lotId) => { onResolve(item.id, lotId); setLinking(false); }}
                  onClose={() => setLinking(false)}
                />
              )}
            </div>
            <button
              onClick={() => onIgnore(item.id)}
              className="px-2 py-1 rounded text-xs text-gray-500 hover:bg-gray-100 transition-colors"
            >
              무시
            </button>
          </div>
        ) : (
          <span className="text-xs text-gray-400">처리됨</span>
        )}
      </td>
    </tr>
  );
}

function LotSearchDropdown({
  onSelect,
  onClose,
}: {
  onSelect: (lotId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { id: string; name: string; address: string }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchParkingLots({ data: { query } });
        setResults(res);
      } catch {}
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div
      ref={ref}
      className="absolute z-50 top-full left-0 mt-1 w-64 bg-white border rounded-lg shadow-lg"
    >
      <input
        autoFocus
        type="text"
        placeholder="주차장 이름 검색..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        className="w-full px-3 py-2 border-b text-xs rounded-t-lg outline-none"
      />
      <div className="max-h-48 overflow-y-auto">
        {searching && (
          <p className="px-3 py-2 text-xs text-gray-400">검색 중...</p>
        )}
        {!searching && query.length >= 2 && results.length === 0 && (
          <p className="px-3 py-2 text-xs text-gray-400">결과 없음</p>
        )}
        {results.map((lot) => (
          <button
            key={lot.id}
            onClick={() => onSelect(lot.id)}
            className="w-full text-left px-3 py-2 hover:bg-blue-50 text-xs border-b last:border-b-0"
          >
            <p className="font-medium text-gray-900">{lot.name}</p>
            <p className="text-gray-400 truncate">{lot.address}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
