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
