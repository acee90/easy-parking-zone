import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "@/db";
import { sql } from "drizzle-orm";
import { makeParkingSlug } from "@/lib/slug";

async function handleSitemap() {
  const db = getDb();

  const rows = (await db.all(
    sql`SELECT id, name FROM parking_lots ORDER BY id`
  )) as { id: string; name: string }[];

  const base = "https://easy-parking.xyz";
  const now = new Date().toISOString().split("T")[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${base}/wiki</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
`;

  for (const row of rows) {
    const slug = encodeURI(makeParkingSlug(row.name, row.id));
    xml += `  <url>
    <loc>${base}/wiki/${slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>
`;
  }

  xml += `</urlset>`;

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
      GET: () => handleSitemap(),
    },
  },
});
