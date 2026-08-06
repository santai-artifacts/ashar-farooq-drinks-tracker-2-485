import db, { derive } from "./db";

const publicDir = `${import.meta.dir}/public`;
const CATEGORIES = ["beer", "wine", "spirits", "cocktail", "seltzer", "other"];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const listDrinks = db.query(`
  SELECT id, name, category, volume_ml, abv, units, calories, note, logged_at
  FROM drinks
  ORDER BY logged_at DESC
  LIMIT 500
`);

// Databases created before sample-data seeding was removed still carry a
// leftover 'seeded' row; exclude it so it never reaches the client.
const readSettings = db.query<{ key: string; value: string }, []>(
  `SELECT key, value FROM settings WHERE key <> 'seeded'`,
);

function settingsObject() {
  const rows = readSettings.all();
  const out: Record<string, number> = {};
  for (const { key, value } of rows) out[key] = Number(value);
  return out;
}

/** Coerce and range-check a numeric field, returning null when unusable. */
function num(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" ? Number(value) : (value as number);
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

async function handleApi(req: Request, pathname: string): Promise<Response | null> {
  const { method } = req;

  if (pathname === "/api/state" && method === "GET") {
    return json({ drinks: listDrinks.all(), settings: settingsObject() });
  }

  if (pathname === "/api/drinks" && method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Expected a JSON body." }, 400);
    }

    const name = String(body.name ?? "").trim().slice(0, 80);
    const category = String(body.category ?? "other");
    const volumeMl = num(body.volume_ml, 1, 3000);
    const abv = num(body.abv, 0, 96);

    if (!name) return json({ error: "A drink needs a name." }, 400);
    if (!CATEGORIES.includes(category)) return json({ error: "Unknown category." }, 400);
    if (volumeMl === null) return json({ error: "Volume must be between 1 and 3000 ml." }, 400);
    if (abv === null) return json({ error: "ABV must be between 0 and 96%." }, 400);

    // Reject a timestamp we can't parse rather than silently storing "Invalid Date".
    let loggedAt = new Date();
    if (body.logged_at) {
      const parsed = new Date(String(body.logged_at));
      if (Number.isNaN(parsed.getTime())) return json({ error: "Unreadable date." }, 400);
      loggedAt = parsed;
    }

    const note = String(body.note ?? "").trim().slice(0, 200);
    const { units, calories } = derive(volumeMl, abv, category);

    const row = db
      .query(
        `INSERT INTO drinks (name, category, volume_ml, abv, units, calories, note, logged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id, name, category, volume_ml, abv, units, calories, note, logged_at`,
      )
      .get(name, category, volumeMl, abv, units, calories, note, loggedAt.toISOString());

    return json(row, 201);
  }

  if (pathname === "/api/drinks" && method === "DELETE") {
    db.query(`DELETE FROM drinks`).run();
    return json({ ok: true });
  }

  const drinkMatch = pathname.match(/^\/api\/drinks\/(\d+)$/);
  if (drinkMatch && method === "DELETE") {
    const changes = db.query(`DELETE FROM drinks WHERE id = ?`).run(Number(drinkMatch[1])).changes;
    if (!changes) return json({ error: "No such drink." }, 404);
    return json({ ok: true });
  }

  if (pathname === "/api/settings" && method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Expected a JSON body." }, 400);
    }

    const limit = num(body.weekly_limit, 0, 200);
    if (limit === null) return json({ error: "Weekly limit must be between 0 and 200." }, 400);

    db.query(`UPDATE settings SET value = ? WHERE key = 'weekly_limit'`).run(String(limit));
    return json(settingsObject());
  }

  return null;
}

export default {
  port: process.env.PORT || 3000,

  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname.startsWith("/api/")) {
      try {
        const res = await handleApi(req, pathname);
        return res ?? json({ error: "Not found." }, 404);
      } catch (err) {
        console.error("API error:", err);
        return json({ error: "Something went wrong on the server." }, 500);
      }
    }

    if (pathname.includes("..")) return new Response("Not found", { status: 404 });

    const file = Bun.file(`${publicDir}${pathname === "/" ? "/index.html" : pathname}`);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
};
