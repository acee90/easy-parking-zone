import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getDb } from "@/db";
import { sql } from "drizzle-orm";
import { fetchSiteStats } from "@/server/parking";
import { Header } from "@/components/Header";
import {
  getDifficultyIcon,
  getDifficultyColor,
} from "@/lib/geo-utils";
import { makeParkingSlug } from "@/lib/slug";
import { rowToParkingLot, type ParkingLotRow } from "@/server/transforms";
import type { ParkingLot } from "@/types/parking";
import { ChevronRight } from "lucide-react";

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
  loader: async () => {
    const [data, siteStats] = await Promise.all([fetchWikiHome(), fetchSiteStats()]);
    return { ...data, siteStats };
  },
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
        property: "og:url",
        content: "https://easy-parking.xyz/wiki",
      },
    ],
  }),
  component: WikiHomePage,
});

function WikiHomePage() {
  const { hell, easy, popular, siteStats } = Route.useLoaderData();

  return (
    <div className="min-h-screen bg-gray-50">
      <Header active="wiki" siteStats={siteStats} />

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
