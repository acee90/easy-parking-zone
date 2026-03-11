/** cloudflare:workers mock for vitest */
export const env: Record<string, unknown> = {
  DB: {},
  KAKAO_CLIENT_ID: "test_kakao_key",
  VITE_NAVER_MAP_CLIENT_ID: "test_naver_key",
  BETTER_AUTH_URL: "http://localhost:3000",
};
