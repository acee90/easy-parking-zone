import { describe, it, expect, vi, beforeEach } from "vitest";
import { createD1Binding } from "./d1-proxy";

// D1 REST API 응답 헬퍼
function mockApiResponse(results: Record<string, unknown>[], meta = {}) {
  return {
    result: [{ results, success: true, meta }],
  };
}

// fetch mock 설정
function setupFetch(response: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(response),
    text: () => Promise.resolve(JSON.stringify(response)),
  });
}

describe("createD1Binding", () => {
  const TOKEN = "test-api-token";
  const ACCOUNT_ID = "test-account";
  const DB_ID = "test-db";
  let db: D1Database;

  beforeEach(() => {
    vi.restoreAllMocks();
    db = createD1Binding(TOKEN, ACCOUNT_ID, DB_ID);
  });

  // ============================================================
  // prepare().bind().all() — 가장 자주 쓰는 패턴
  // ============================================================

  describe("prepare().bind().all()", () => {
    it("파라미터 바인딩 후 결과를 오브젝트 배열로 반환", async () => {
      const rows = [
        { id: "PK-001", name: "서울역 주차장", lat: 37.55, lng: 126.97 },
        { id: "PK-002", name: "강남역 주차장", lat: 37.50, lng: 127.03 },
      ];
      globalThis.fetch = setupFetch(mockApiResponse(rows));

      const result = await db.prepare("SELECT * FROM parking_lots WHERE lat > ?").bind(37.0).all();

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual(rows[0]);
      expect(result.results[1]).toEqual(rows[1]);
    });

    it("빈 결과 처리", async () => {
      globalThis.fetch = setupFetch(mockApiResponse([]));

      const result = await db.prepare("SELECT * FROM parking_lots WHERE id = ?").bind("없음").all();

      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
    });

    it("Authorization 헤더에 토큰 포함", async () => {
      globalThis.fetch = setupFetch(mockApiResponse([]));

      await db.prepare("SELECT 1").all();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/d1/database/"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${TOKEN}`,
          }),
        }),
      );
    });

    it("SQL과 params를 body에 포함", async () => {
      globalThis.fetch = setupFetch(mockApiResponse([]));

      await db.prepare("SELECT * FROM t WHERE a = ? AND b = ?").bind("x", 42).all();

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.sql).toBe("SELECT * FROM t WHERE a = ? AND b = ?");
      expect(body.params).toEqual(["x", 42]);
    });
  });

  // ============================================================
  // prepare().bind().first() — 단일 행 조회
  // ============================================================

  describe("prepare().bind().first()", () => {
    it("첫 번째 행을 반환", async () => {
      const row = { id: 1, name: "테스트" };
      globalThis.fetch = setupFetch(mockApiResponse([row, { id: 2, name: "기타" }]));

      const result = await db.prepare("SELECT * FROM t LIMIT 1").first();

      expect(result).toEqual(row);
    });

    it("컬럼명 지정 시 해당 값만 반환", async () => {
      globalThis.fetch = setupFetch(mockApiResponse([{ id: 1, name: "테스트", count: 42 }]));

      const result = await db.prepare("SELECT count(*) as count FROM t").first("count");

      expect(result).toBe(42);
    });

    it("결과 없으면 null 반환", async () => {
      globalThis.fetch = setupFetch(mockApiResponse([]));

      const result = await db.prepare("SELECT * FROM t WHERE id = ?").bind(999).first();

      expect(result).toBeNull();
    });
  });

  // ============================================================
  // prepare().bind().run() — INSERT/UPDATE/DELETE
  // ============================================================

  describe("prepare().bind().run()", () => {
    it("success: true 반환", async () => {
      globalThis.fetch = setupFetch(mockApiResponse([]));

      const result = await db.prepare("INSERT INTO t (name) VALUES (?)").bind("new").run();

      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // prepare().bind().raw() — 값 배열 형태 반환
  // ============================================================

  describe("prepare().bind().raw()", () => {
    it("오브젝트를 값 배열로 변환하여 반환", async () => {
      globalThis.fetch = setupFetch(
        mockApiResponse([
          { id: 1, name: "A", score: 3.5 },
          { id: 2, name: "B", score: 4.2 },
        ]),
      );

      const result = await db.prepare("SELECT id, name, score FROM t").raw();

      expect(result).toEqual([
        [1, "A", 3.5],
        [2, "B", 4.2],
      ]);
    });
  });

  // ============================================================
  // bind() 체이닝
  // ============================================================

  describe("bind() 체이닝", () => {
    it("bind() 없이 호출 가능", async () => {
      globalThis.fetch = setupFetch(mockApiResponse([{ cnt: 5 }]));

      const result = await db.prepare("SELECT count(*) as cnt FROM t").all();

      expect(result.results).toEqual([{ cnt: 5 }]);
      const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.params).toEqual([]);
    });

    it("bind()가 같은 statement를 반환 (체이닝)", async () => {
      const stmt = db.prepare("SELECT 1");
      const bound = stmt.bind(1, 2, 3);
      expect(bound).toBe(stmt);
    });
  });

  // ============================================================
  // 에러 처리
  // ============================================================

  describe("에러 처리", () => {
    it("API 4xx/5xx 에러 시 throw", async () => {
      globalThis.fetch = setupFetch({ errors: ["unauthorized"] }, false, 401);

      await expect(
        db.prepare("SELECT 1").all(),
      ).rejects.toThrow("[D1 Proxy] API error: 401");
    });

    it("네트워크 에러 전파", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("fetch failed"));

      await expect(
        db.prepare("SELECT 1").all(),
      ).rejects.toThrow("fetch failed");
    });
  });

  // ============================================================
  // exec()
  // ============================================================

  describe("exec()", () => {
    it("SQL 실행 후 count 반환", async () => {
      globalThis.fetch = setupFetch(mockApiResponse([]));

      const result = await db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)");

      expect(result).toEqual({ count: 1, duration: 0 });
    });
  });

  // ============================================================
  // batch()
  // ============================================================

  describe("batch()", () => {
    it("여러 statement를 순차 실행", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const rows = callCount === 1
          ? [{ id: 1 }]
          : [{ id: 2 }, { id: 3 }];
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockApiResponse(rows)),
        });
      });

      const results = await db.batch([
        db.prepare("SELECT * FROM a"),
        db.prepare("SELECT * FROM b"),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].results).toEqual([{ id: 1 }]);
      expect(results[1].results).toEqual([{ id: 2 }, { id: 3 }]);
    });
  });

  // ============================================================
  // dump() — 미지원
  // ============================================================

  describe("dump()", () => {
    it("미지원 에러 throw", async () => {
      await expect(db.dump()).rejects.toThrow("not supported");
    });
  });
});
