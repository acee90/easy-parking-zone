import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "@/db";
import { sql } from "drizzle-orm";
import { makeParkingSlug } from "@/lib/slug";

async function handleTestSitemap() {
  const db = getDb();

  const rows = (await db.all(
    sql`SELECT id, name FROM parking_lots ORDER BY id LIMIT 10`
  )) as { id: string; name: string }[];

  const base = "https://easy-parking.xyz";
  const now = new Date().toISOString().split("T")[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

  for (const row of rows) {
    const slug = encodeURI(makeParkingSlug(row.name, row.id));
    xml += `
  <url>
    <loc>${base}/wiki/${slug}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`;
  }

  xml += `
</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export const Route = createFileRoute("/sitemap-test.xml")({
  server: {
    handlers: {
      GET: () => handleTestSitemap(),
    },
  },
});
