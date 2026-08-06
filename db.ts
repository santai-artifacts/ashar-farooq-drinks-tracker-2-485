import Database from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const dbPath = process.env.DATABASE_URL || "./data/app.db";
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS drinks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    category   TEXT    NOT NULL,
    volume_ml  REAL    NOT NULL,
    abv        REAL    NOT NULL,
    units      REAL    NOT NULL,
    calories   INTEGER NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    logged_at  TEXT    NOT NULL
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_drinks_logged_at ON drinks(logged_at DESC)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

db.query(`INSERT OR IGNORE INTO settings (key, value) VALUES ('weekly_limit', '14')`).run();
db.query(`INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded', '0')`).run();

/**
 * A brand-new database shows an empty chart and no history, which reads as
 * broken rather than new. Seed a plausible fortnight once, then never again —
 * the UI exposes a "clear everything" action for starting clean.
 */
export function seedIfEmpty() {
  const seeded = db.query<{ value: string }, []>(`SELECT value FROM settings WHERE key = 'seeded'`).get();
  if (seeded?.value === "1") return;

  const count = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM drinks`).get();
  if ((count?.n ?? 0) === 0) {
    // [days ago, hour, name, category, ml, abv]
    const sample: [number, number, string, string, number, number][] = [
      [12, 20, "Guinness Draught", "beer", 568, 4.2],
      [12, 21, "Guinness Draught", "beer", 568, 4.2],
      [10, 19, "Sancerre", "wine", 175, 12.5],
      [9, 18, "Negroni", "cocktail", 90, 24],
      [9, 20, "Chianti Classico", "wine", 150, 13.5],
      [8, 21, "Talisker 10, neat", "spirits", 44, 45.8],
      [6, 13, "Sierra Nevada Pale Ale", "beer", 355, 5.6],
      [6, 19, "Sierra Nevada Pale Ale", "beer", 355, 5.6],
      [5, 22, "Old Fashioned", "cocktail", 100, 32],
      [3, 18, "High Noon Lime", "seltzer", 355, 4.5],
      [2, 20, "Côtes du Rhône", "wine", 150, 14],
      [2, 21, "Côtes du Rhône", "wine", 150, 14],
    ];

    const insert = db.query(`
      INSERT INTO drinks (name, category, volume_ml, abv, units, calories, note, logged_at)
      VALUES (?, ?, ?, ?, ?, ?, '', ?)
    `);

    const tx = db.transaction(() => {
      for (const [daysAgo, hour, name, category, ml, abv] of sample) {
        const when = new Date();
        when.setDate(when.getDate() - daysAgo);
        when.setHours(hour, 0, 0, 0);
        const { units, calories } = derive(ml, abv, category);
        insert.run(name, category, ml, abv, units, calories, when.toISOString());
      }
    });
    tx();
  }

  db.query(`UPDATE settings SET value = '1' WHERE key = 'seeded'`).run();
}

/** One US standard drink = 14 g of pure alcohol ≈ 17.74 ml of ethanol. */
const ETHANOL_ML_PER_UNIT = 17.74;
const ETHANOL_G_PER_ML = 0.789;
const KCAL_PER_G_ETHANOL = 7;

/**
 * Non-alcohol calories (sugar, malt, mixers) per 100 ml, by category. Rough
 * figures reverse-engineered from typical nutrition panels — the UI labels
 * calories as an estimate.
 */
const RESIDUAL_KCAL_PER_100ML: Record<string, number> = {
  beer: 14.6,
  wine: 17,
  spirits: 0,
  cocktail: 40,
  seltzer: 2,
  other: 10,
};

export function derive(volumeMl: number, abv: number, category: string) {
  const ethanolMl = volumeMl * (abv / 100);
  const units = ethanolMl / ETHANOL_ML_PER_UNIT;
  const kcal =
    ethanolMl * ETHANOL_G_PER_ML * KCAL_PER_G_ETHANOL +
    ((RESIDUAL_KCAL_PER_100ML[category] ?? RESIDUAL_KCAL_PER_100ML.other) * volumeMl) / 100;

  return { units: Math.round(units * 100) / 100, calories: Math.round(kcal) };
}

export default db;
