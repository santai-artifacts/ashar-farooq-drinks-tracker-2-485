import Database from "bun:sqlite";

const db = new Database(process.env.DATABASE_URL || "./data/app.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS drinks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const publicDir = `${import.meta.dir}/public`;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Local day string (server time) so "today" groups sensibly.
const todayStr = () => new Date().toISOString().slice(0, 10);

export default {
  port: process.env.PORT || 3000,
  async fetch(req: Request) {
    const { pathname } = new URL(req.url);

    // --- API ---
    if (pathname === "/api/drinks" && req.method === "GET") {
      const rows = db
        .query(
          `SELECT id, kind, amount, created_at
           FROM drinks
           WHERE date(created_at) = date('now')
           ORDER BY id DESC`
        )
        .all();
      const total = rows.reduce((s: number, r: any) => s + r.amount, 0);
      return json({ drinks: rows, total, date: todayStr() });
    }

    if (pathname === "/api/drinks" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { kind?: string; amount?: number }
        | null;
      const kind = body?.kind?.trim();
      const amount = Number(body?.amount);
      if (!kind || !Number.isFinite(amount) || amount <= 0) {
        return json({ error: "kind and positive amount required" }, 400);
      }
      const info = db.run(
        "INSERT INTO drinks (kind, amount) VALUES (?, ?)",
        [kind, Math.round(amount)]
      );
      return json({ id: info.lastInsertRowid }, 201);
    }

    const del = pathname.match(/^\/api\/drinks\/(\d+)$/);
    if (del && req.method === "DELETE") {
      db.run("DELETE FROM drinks WHERE id = ?", [Number(del[1])]);
      return json({ ok: true });
    }

    // --- Static ---
    const filePath = `${publicDir}${pathname === "/" ? "/index.html" : pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
};
