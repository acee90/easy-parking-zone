import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
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
import { ChevronRight, Search, X, Loader2 } from "lucide-react";

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
  const [results, setResults] = useState<ParkingLot[] | null>(null);
  const [searching, setSearching] = useState(false);

  const handleSearch = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    try {
      const lots = await searchParkingLots({ data: { query: q } });
      setResults(lots);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const clear = () => {
    setQuery("");
    setResults(null);
  };

  return (
    <div className="max-w-2xl mx-auto px-4 pt-6 pb-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="주차장 이름 또는 주소로 검색"
          className="w-full pl-9 pr-16 py-2.5 text-sm rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {query && (
            <button onClick={clear} className="p-1 hover:bg-gray-100 rounded-full cursor-pointer">
              <X className="size-3.5 text-muted-foreground" />
            </button>
          )}
          <button
            onClick={handleSearch}
            disabled={query.trim().length < 2 || searching}
            className="px-2.5 py-1 text-xs font-medium bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {searching ? <Loader2 className="size-3 animate-spin" /> : "검색"}
          </button>
        </div>
      </div>

      {results !== null && (
        <div className="mt-3 bg-white rounded-lg border overflow-hidden">
          {results.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              검색 결과가 없습니다
            </p>
          ) : (
            <div className="divide-y max-h-80 overflow-y-auto">
              {results.map((lot) => (
                <Link
                  key={lot.id}
                  to="/wiki/$slug"
                  params={{ slug: makeParkingSlug(lot.name, lot.id) }}
                  className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50 transition-colors"
                >
                  <div className={`size-2.5 rounded-full shrink-0 ${getDifficultyColor(lot.difficulty.score)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{lot.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{lot.address}</div>
                  </div>
                  <span className="shrink-0 text-sm">{getDifficultyIcon(lot.difficulty.score)}</span>
                  <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
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
