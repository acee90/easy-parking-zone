import { createFileRoute } from "@tanstack/react-router";
import { getDb } from "@/db";
import { sql } from "drizzle-orm";
import { makeParkingSlug } from "@/lib/slug";
import { URLS_PER_SITEMAP } from "@/lib/sitemap";

async function handleSitemapPage(id: number) {
  const db = getDb();
  const offset = id * URLS_PER_SITEMAP;

  const rows = (await db.all(
    sql`SELECT id, name FROM parking_lots ORDER BY id LIMIT ${URLS_PER_SITEMAP} OFFSET ${offset}`
  )) as { id: string; name: string }[];

  if (rows.length === 0) {
    return new Response("Not Found", { status: 404 });
  }

  const base = "https://easy-parking.xyz";

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

  for (const row of rows) {
    const slug = encodeURI(makeParkingSlug(row.name, row.id));
    xml += `
  <url>
    <loc>${base}/wiki/${slug}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`;
  }

  xml += `
</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export const Route = createFileRoute("/sitemap/$id")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const id = parseInt(params.id, 10);
        if (isNaN(id) || id < 0 || id > 999) {
          return new Response("Not Found", { status: 404 });
        }
        return handleSitemapPage(id);
      },
    },
  },
});
