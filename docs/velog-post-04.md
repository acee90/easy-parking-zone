# [쉬운주차장] Cloudflare D1 + Drizzle ORM 전환기: 로컬 개발 환경의 함정들 #4

## 1. Raw SQL에서 ORM으로

지난 포스팅에서 베이지안 통합 점수로 3만 5천 개 주차장의 난이도를 산출한 이야기를 했습니다. 그런데 쿼리가 점점 복잡해지면서 raw SQL의 한계가 보이기 시작했습니다. 조인, 필터, 정렬 조건이 동적으로 바뀌는 쿼리를 문자열로 관리하니 실수도 잦고 타입 안전성도 없었습니다.

그래서 **Drizzle ORM**을 도입했습니다. Cloudflare D1과 궁합이 좋고, SQL에 가까운 문법이라 기존 쿼리를 옮기기 수월할 거라 판단했습니다.

---

## 2. 전환은 순조로웠다 (처음엔)

스키마 정의(`drizzle-orm/sqlite-core`)부터 시작해서 17개 테이블을 `src/db/schema.ts`에 선언하고, `getDb()` 함수로 인스턴스를 생성하는 구조를 잡았습니다.

```typescript
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import * as schema from "./schema";

export function getDb() {
  return drizzle(env.DB, { schema });
}
```

단순한 CRUD 쿼리는 Drizzle의 쿼리 빌더로 깔끔하게 전환됐습니다.

```typescript
// Before: raw SQL
const result = await db.prepare("SELECT * FROM user_reviews WHERE parking_lot_id = ?").bind(id).all();

// After: Drizzle
const reviews = await db.select().from(schema.userReviews)
  .where(eq(schema.userReviews.parkingLotId, id));
```

프로덕션 배포 후 정상 동작을 확인하고, 로컬에서도 확인하려고 `bun dev`를 켰는데...

**마커가 하나도 안 뜹니다.**

---

## 3. 첫 번째 함정: `db.run()` vs `db.all()`

로그를 찍어보니 DB 연결 자체는 정상이었습니다. 쿼리도 실행되고 있었고요. 문제는 **결과를 읽는 방식**이었습니다.

기존 raw D1에서는 `db.prepare().all()`을 쓰면 `{ results: [...] }` 형태로 데이터가 왔습니다. Drizzle로 전환하면서 동적 쿼리에 `db.run(sql.raw(...))` 패턴을 사용했는데, 여기서 문제가 터졌습니다.

```typescript
// 이렇게 쓰고 있었는데
const result = await db.run(sql.raw(`SELECT ...`));
const rows = result.rows; // undefined!
```

`result`를 열어보니 `{ success, meta, results }` 구조였습니다. **`rows`가 아니라 `results`에 데이터가 있었던 겁니다.** 그런데 프로덕션(Cloudflare Workers)에서는 `rows`로 정상 동작했습니다.

원인은 **로컬 miniflare와 프로덕션 Workers의 D1 바인딩 반환 형태가 다르기 때문**이었습니다.

해결은 단순했습니다. `db.run()` 대신 `db.all()`을 쓰면 양쪽 환경 모두에서 배열을 직접 반환합니다.

```typescript
// Before: 환경마다 반환 형태가 다름
const result = await db.run(sql.raw(`SELECT ...`));

// After: 양쪽 모두 배열 반환
const rows = await db.all(sql.raw(`SELECT ...`));
```

이 패턴이 `parking.ts`에 3곳, `admin.ts`에 13곳 있었습니다. 전부 수정했습니다.

---

## 4. 두 번째 함정: Cloudflare Vite Plugin은 Remote D1을 지원하지 않는다

마커가 뜨긴 하는데, 데이터가 텅 비어있었습니다. 이전까지는 `wrangler.jsonc`에 `"remote": true`를 넣어서 로컬 dev 서버가 프로덕션 D1에 직접 연결되게 사용하고 있었거든요.

Drizzle 전환 과정에서 이 설정을 다시 확인해보니... **Cloudflare Vite Plugin은 remote D1을 지원하지 않습니다.** `wrangler dev --remote`는 되지만, Vite 플러그인 기반 개발 서버에서는 항상 로컬 miniflare의 D1을 사용합니다.

공식 문서에도 이렇게 적혀 있었습니다:

> "Remote development is not supported in the Vite plugin"

그동안 `remote: true`가 동작한다고 착각하고 있었던 겁니다.

---

## 5. 해결책: Drizzle sqlite-proxy로 Remote D1 직접 연결

로컬 DB에 매번 덤프를 떠오는 방식도 있지만, 데이터 업데이트가 잦은 개발 단계에서는 번거롭습니다. Drizzle ORM의 `sqlite-proxy` 드라이버를 활용하면 **Cloudflare D1 REST API를 통해 remote DB에 직접 연결**할 수 있습니다.

```typescript
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";

function createD1Proxy(apiToken: string) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;

  return drizzleProxy(
    async (sql, params, method) => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
      });

      const data = await res.json();
      const rows = data.result?.[0]?.results ?? [];

      if (method === "get") {
        return { rows: rows[0] ? [rows[0]] : [] };
      }
      return { rows };
    },
    { schema },
  );
}

export function getDb() {
  const proxyToken = env.D1_PROXY_TOKEN;
  if (proxyToken) {
    return createD1Proxy(proxyToken); // remote D1
  }
  return drizzleD1(env.DB, { schema }); // local or production
}
```

`.dev.vars`에 `D1_PROXY_TOKEN`만 넣어두면 로컬 dev 서버가 프로덕션 D1을 직접 바라봅니다. 토큰을 빼면 로컬 miniflare D1로 폴백되고요.

---

## 6. 정리: 로컬 개발 환경 두 가지 방식

결과적으로 Cloudflare D1 + Drizzle ORM 환경에서 로컬 개발은 두 가지 방식으로 정리됐습니다.

| 방식 | 장점 | 단점 |
|------|------|------|
| **로컬 DB 덤프** (`wrangler d1 export --remote`) | 오프라인 가능, 빠른 쿼리 | 데이터 싱크 수동 |
| **sqlite-proxy** (D1 REST API) | 항상 최신 데이터 | API 토큰 필요, 네트워크 의존 |

프로덕션 배포 시에는 어느 쪽이든 영향 없습니다. `D1_PROXY_TOKEN`은 `.dev.vars`에만 존재하고, 프로덕션에서는 기존 D1 바인딩이 그대로 사용됩니다.

---

## 7. 마치며

ORM 전환 자체보다 **로컬과 프로덕션의 미묘한 차이**를 파악하는 데 시간이 더 걸렸습니다. `db.run()`의 반환 형태가 환경마다 다르다는 건 문서에 명시되어 있지 않아서, 로그를 찍어가며 하나씩 확인해야 했습니다.

교훈을 정리하면:

1. **Drizzle + D1에서는 `db.all()`을 쓰자.** `db.run()`은 환경별 반환 형태가 다르다.
2. **Cloudflare Vite Plugin은 remote D1을 지원하지 않는다.** `wrangler.jsonc`의 `remote: true`는 Vite 플러그인에서 무시된다.
3. **sqlite-proxy는 좋은 대안이다.** D1 REST API를 통해 로컬에서 remote DB를 직접 사용할 수 있다.

다음 포스팅에서는 이 인프라 위에서 난이도 UI를 고도화한 작업을 공유하겠습니다.

끝.

---

### 🏷️ 태그 (Tag)
#개발일기 #사이드프로젝트 #CloudflareD1 #DrizzleORM #sqliteProxy #트러블슈팅 #주차장지도
