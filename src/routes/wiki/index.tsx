import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useRef, useEffect, useCallback } from "react";
import { getDb } from "@/db";
import { sql } from "drizzle-orm";
import {
  getDifficultyIcon,
  getDifficultyColor,
} from "@/lib/geo-utils";
import { makeParkingSlug } from "@/lib/slug";
import { rowToParkingLot, type ParkingLotRow } from "@/server/transforms";
import { searchParkingLots } from "@/server/parking";
import type { ParkingLot } from "@/types/parking";
import { ChevronRight, Search, X, MapPin } from "lucide-react";

const fetchWikiHome = createServerFn({ method: "GET" }).handler(async () => {
  const db = getDb();

  // 헬 주차장 TOP
  const hellRows = await db.all(
    sql.raw(
      `SELECT p.*,
        s.final_score as avg_score,
        COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
        s.reliability
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.curation_tag = 'hell'
      ORDER BY s.final_score ASC
      LIMIT 10`
    )
  );

  // 초보 추천 TOP
  const easyRows = await db.all(
    sql.raw(
      `SELECT p.*,
        s.final_score as avg_score,
        COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
        s.reliability
      FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE p.curation_tag = 'easy'
      ORDER BY s.final_score DESC
      LIMIT 10`
    )
  );

  // 리뷰 많은 주차장
  const popularRows = await db.all(
    sql.raw(
      `SELECT p.*,
        s.final_score as avg_score,
        COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
        s.reliability
      FROM parking_lots p
      JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE s.reliability IN ('confirmed', 'estimated')
      ORDER BY (s.user_review_count + s.community_count) DESC
      LIMIT 10`
    )
  );

  return {
    hell: (hellRows as unknown as ParkingLotRow[]).map(rowToParkingLot),
    easy: (easyRows as unknown as ParkingLotRow[]).map(rowToParkingLot),
    popular: (popularRows as unknown as ParkingLotRow[]).map(rowToParkingLot),
  };
});

export const Route = createFileRoute("/wiki/")({
  loader: () => fetchWikiHome(),
  head: () => ({
    meta: [
      { title: "주차장 위키 — 전국 주차장 난이도 정보 | 쉬운주차장" },
      {
        name: "description",
        content:
          "전국 주차장의 난이도, 요금, 리뷰를 한눈에. 헬 주차장 TOP, 초보 추천 주차장을 확인하세요.",
      },
      {
        property: "og:title",
        content: "주차장 위키 — 전국 주차장 난이도 정보 | 쉬운주차장",
      },
      {
        property: "og:description",
        content:
          "전국 주차장의 난이도, 요금, 리뷰를 한눈에. 헬 주차장 TOP, 초보 추천 주차장을 확인하세요.",
      },
      {
        property: "og:url",
        content: "https://easy-parking.xyz/wiki",
      },
    ],
  }),
  component: WikiHomePage,
});

function WikiSearchBar() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ParkingLot[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 1) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const lots = await searchParkingLots({ data: { query: trimmed } });
      setResults(lots);
      setOpen(lots.length > 0);
    } catch {
      setResults([]);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (value: string) => {
    setQuery(value);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(value), 300);
  };

  const handleSelect = (lot: ParkingLot) => {
    setQuery(lot.name);
    setOpen(false);
    navigate({
      to: "/wiki/$slug",
      params: { slug: makeParkingSlug(lot.name, lot.id) },
    });
  };

  const clear = () => {
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-4 pt-6 pb-2">
      <div ref={containerRef} className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="주차장 이름 또는 주소로 검색"
          className="w-full pl-9 pr-9 py-2.5 text-sm rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
        />
        {query && (
          <button
            onClick={clear}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 hover:bg-gray-100 rounded-full cursor-pointer"
          >
            <X className="size-3.5 text-muted-foreground" />
          </button>
        )}

        {open && (
          <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-lg border bg-white shadow-lg overflow-hidden">
            {loading ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                검색 중...
              </div>
            ) : (
              <>
                <div className="max-h-72 overflow-y-auto divide-y">
                  {results.map((lot) => (
                    <button
                      key={lot.id}
                      onClick={() => handleSelect(lot)}
                      className="w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <MapPin className="size-3.5 text-blue-500 shrink-0" />
                        <span className="text-sm font-medium truncate">{lot.name}</span>
                        <span className="shrink-0 text-xs">{getDifficultyIcon(lot.difficulty.score)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate pl-5.5">{lot.address}</p>
                    </button>
                  ))}
                </div>
                <div className="border-t bg-gray-50 px-3 py-1 text-[11px] text-muted-foreground text-right">
                  주차장 {results.length}건
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WikiHomePage() {
  const { hell, easy, popular } = Route.useLoaderData();

  return (
    <div className="min-h-screen bg-gray-50">
      <WikiSearchBar />

      {/* 2열 그리드 */}
      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <RankingSection
            title="💀 헬 주차장 TOP"
            description="초보운전자가 피해야 할 주차장"
            lots={hell}
            variant="hell"
          />
          <RankingSection
            title="😊 초보 추천 주차장"
            description="넓고 여유로워 초보도 편한 주차장"
            lots={easy}
            variant="easy"
          />
          <RankingSection
            title="🗣️ 리뷰가 많은 주차장"
            description="실제 이용자 리뷰로 검증된 주차장"
            lots={popular}
            variant="popular"
            className="md:col-span-2"
          />
        </div>
      </div>
    </div>
  );
}

function RankingSection({
  title,
  description,
  lots,
  variant,
  className,
}: {
  title: string;
  description: string;
  lots: ParkingLot[];
  variant: "hell" | "easy" | "popular";
  className?: string;
}) {
  if (lots.length === 0) return null;

  // col-span-2일 때 리스트를 2열로 분할
  const isWide = className?.includes("col-span-2");
  const mid = isWide ? Math.ceil(lots.length / 2) : lots.length;
  const col1 = lots.slice(0, mid);
  const col2 = isWide ? lots.slice(mid) : [];

  return (
    <section className={`bg-white rounded-xl border overflow-hidden ${className ?? ""}`}>
      <div className="px-4 pt-4 pb-2">
        <h2 className="font-semibold text-sm">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className={isWide ? "grid grid-cols-1 md:grid-cols-2" : ""}>
        <RankingList lots={col1} startIndex={0} />
        {col2.length > 0 && (
          <RankingList lots={col2} startIndex={mid} className="md:border-l" />
        )}
      </div>
    </section>
  );
}

function RankingList({
  lots,
  startIndex,
  className,
}: {
  lots: ParkingLot[];
  startIndex: number;
  className?: string;
}) {
  return (
    <div className={`divide-y ${className ?? ""}`}>
      {lots.map((lot, i) => (
        <Link
          key={lot.id}
          to="/wiki/$slug"
          params={{ slug: makeParkingSlug(lot.name, lot.id) }}
          className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50 transition-colors"
        >
          <span className="text-xs font-medium text-muted-foreground w-4 text-right shrink-0">
            {startIndex + i + 1}
          </span>
          <div
            className={`size-2.5 rounded-full shrink-0 ${getDifficultyColor(lot.difficulty.score)}`}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{lot.name}</div>
          </div>
          <span className="shrink-0 text-sm">
            {getDifficultyIcon(lot.difficulty.score)}
          </span>
          {lot.difficulty.reviewCount > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {lot.difficulty.reviewCount}
            </span>
          )}
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        </Link>
      ))}
    </div>
  );
}
