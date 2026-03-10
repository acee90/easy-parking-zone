import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { authClient } from "@/lib/auth-client";
import {
  checkAdminAccess,
  fetchSignals,
  fetchSignalStats,
  tagSignal,
  removeLotFromSignal,
  addLotToSignal,
  searchParkingLots,
  type SignalItem,
} from "@/server/admin";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

function AdminPage() {
  const { data: session } = authClient.useSession();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [stats, setStats] = useState<Awaited<
    ReturnType<typeof fetchSignalStats>
  > | null>(null);
  const [signals, setSignals] = useState<SignalItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<
    "pending" | "tagged" | "irrelevant" | "all"
  >("pending");
  const [lotSearch, setLotSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = () => {
    setLoading(true);
    Promise.all([
      fetchSignals({
        data: {
          status: statusFilter,
          lotSearch: lotSearch || undefined,
          page,
          limit: 50,
        },
      }),
      fetchSignalStats(),
    ]).then(([res, s]) => {
      setSignals(res.items);
      setTotal(res.total);
      setStats(s);
      setLoading(false);
    });
  };

  useEffect(() => {
    checkAdminAccess().then((r) => setIsAdmin(r.isAdmin));
  }, [session]);

  useEffect(() => {
    if (!isAdmin) return;
    reload();
  }, [isAdmin, statusFilter, lotSearch, page]);

  if (isAdmin === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-500">로딩 중...</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-2xl font-bold mb-2">접근 권한 없음</p>
          <p className="text-gray-500">관리자만 접근할 수 있습니다.</p>
        </div>
      </div>
    );
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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">쉬운주차장 Admin</h1>
            <p className="text-sm text-gray-500">카페 시그널 검수</p>
          </div>
          <a href="/" className="text-sm text-blue-600 hover:underline">
            ← 서비스로 돌아가기
          </a>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatCard label="전체 시그널" value={stats.total} />
            <StatCard label="미검수" value={stats.pending} highlight />
            <StatCard label="검수완료" value={stats.tagged} color="green" />
            <StatCard label="무관 처리" value={stats.irrelevant} color="gray" />
          </div>
        )}

        {/* Filters */}
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
              setLotSearch(e.target.value);
              setPage(1);
            }}
            className="ml-auto px-3 py-1.5 border rounded-md text-sm w-48"
          />
          <span className="text-sm text-gray-500">{total}건</span>
        </div>

        {/* Table */}
        {loading ? (
          <div className="text-center py-12 text-gray-500">로딩 중...</div>
        ) : signals.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            데이터가 없습니다.
          </div>
        ) : (
          <div className="bg-white rounded-lg border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b text-left">
                    <th className="px-4 py-3 font-medium text-gray-600 w-56">
                      관련 주차장
                    </th>
                    <th className="px-4 py-3 font-medium text-gray-600">
                      언급 스니펫
                    </th>
                    <th className="px-4 py-3 font-medium text-gray-600 w-56">
                      카페 제목
                    </th>
                    <th className="px-4 py-3 font-medium text-gray-600 w-16 text-center">
                      AI
                    </th>
                    <th className="px-4 py-3 font-medium text-gray-600 w-56 text-center">
                      액션
                    </th>
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

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex justify-center gap-2 mt-4">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
            >
              이전
            </button>
            <span className="px-3 py-1.5 text-sm text-gray-600">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 rounded border text-sm disabled:opacity-50"
            >
              다음
            </button>
          </div>
        )}
      </main>
    </div>
  );
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
