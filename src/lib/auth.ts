import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins";
import { withCloudflare } from "better-auth-cloudflare";
import { env } from "cloudflare:workers";

export function createAuth() {
  return betterAuth(
    withCloudflare(
      {
        d1: {
          db: env.DB,
          options: {
            usePlural: false,
          },
        },
        geolocationTracking: false,
        autoDetectIpAddress: false,
      },
      {
        socialProviders: {
          kakao: {
            clientId: env.KAKAO_CLIENT_ID as string,
            clientSecret: env.KAKAO_CLIENT_SECRET as string,
          },
          naver: {
            clientId: env.NAVER_CLIENT_ID as string,
            clientSecret: env.NAVER_CLIENT_SECRET as string,
          },
          google: {
            clientId: env.GOOGLE_CLIENT_ID as string,
            clientSecret: env.GOOGLE_CLIENT_SECRET as string,
          },
        },
        plugins: [anonymous()],
        baseURL: env.BETTER_AUTH_URL as string | undefined,
      }
    )
  );
}
