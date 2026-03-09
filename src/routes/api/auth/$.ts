import { createFileRoute } from "@tanstack/react-router";
import { createAuth } from "@/lib/auth";

async function handleAuth(request: Request) {
  try {
    const auth = createAuth();
    return await auth.handler(request);
  } catch (err) {
    console.error("[Auth Error]", {
      url: request.url,
      method: request.method,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : err,
    });
    throw err;
  }
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuth(request),
      POST: ({ request }) => handleAuth(request),
    },
  },
});
