import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "@/db";
import { sql } from "drizzle-orm";
import { URLS_PER_SITEMAP } from "@/lib/sitemap";

async function handleSitemapIndex() {
  const db = getDb();

  const result = (await db.get(
    sql`SELECT COUNT(*) as count FROM parking_lots`
  )) as { count: number };

  const totalPages = Math.ceil(result.count / URLS_PER_SITEMAP);
  const base = "https://easy-parking.xyz";
  const now = new Date().toISOString().split("T")[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${base}/sitemap-static.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>`;

  for (let i = 0; i < totalPages; i++) {
    xml += `
  <sitemap>
    <loc>${base}/sitemap/${i}</loc>
    <lastmod>${now}</lastmod>
  </sitemap>`;
  }

  xml += `
</sitemapindex>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => handleSitemapIndex(),
    },
  },
});
