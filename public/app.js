/* Tally — client. State lives here for the session; SQLite is the source of truth. */

const state = { drinks: [], settings: { weekly_limit: 14 } };

const CATEGORY_EMOJI = {
  beer: "🍺",
  wine: "🍷",
  spirits: "🥃",
  cocktail: "🍸",
  seltzer: "🥤",
  other: "🍹",
};

const PRESETS = [
  { name: "Pint of lager", category: "beer", volume_ml: 473, abv: 4.8 },
  { name: "Bottle of beer", category: "beer", volume_ml: 355, abv: 5 },
  { name: "Glass of wine", category: "wine", volume_ml: 150, abv: 13 },
  { name: "Large glass of wine", category: "wine", volume_ml: 250, abv: 13 },
  { name: "Shot of spirits", category: "spirits", volume_ml: 44, abv: 40 },
  { name: "Cocktail", category: "cocktail", volume_ml: 120, abv: 22 },
  { name: "Hard seltzer", category: "seltzer", volume_ml: 355, abv: 4.5 },
  { name: "Glass of prosecco", category: "wine", volume_ml: 125, abv: 11 },
];

/* ---------- shared maths (mirrors db.ts so the form can preview live) ---------- */

const ETHANOL_ML_PER_UNIT = 17.74;
const RESIDUAL_KCAL_PER_100ML = { beer: 14.6, wine: 17, spirits: 0, cocktail: 40, seltzer: 2, other: 10 };

function derive(volumeMl, abv, category) {
  const ethanolMl = volumeMl * (abv / 100);
  const units = ethanolMl / ETHANOL_ML_PER_UNIT;
  const residual = RESIDUAL_KCAL_PER_100ML[category] ?? RESIDUAL_KCAL_PER_100ML.other;
  const kcal = ethanolMl * 0.789 * 7 + (residual * volumeMl) / 100;
  return { units: Math.round(units * 100) / 100, calories: Math.round(kcal) };
}

/* ---------- dates (all grouping happens in the viewer's local time) ---------- */

const $ = (sel) => document.querySelector(sel);

function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday-based week start, matching how most drinking guidance is framed. */
function startOfWeek() {
  const d = startOfToday();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function fmtUnits(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function relativeDayName(key) {
  const today = dayKey(new Date());
  const yesterday = dayKey(addDays(new Date(), -1));
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/* ---------- api ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed. Try again.");
  return data;
}

async function load() {
  try {
    const data = await api("/api/state");
    state.drinks = data.drinks;
    state.settings = { weekly_limit: 14, ...data.settings };
    render();
  } catch (err) {
    renderLoadFailure(err.message);
  }
}

/* ---------- toasts ---------- */

function toast(message, { action, error } = {}) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;

  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);

  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      dismiss();
      action.onClick();
    });
    el.append(btn);
  }

  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 220);
  };

  $("#toasts").append(el);
  setTimeout(dismiss, action ? 6000 : 3000);
}

/* ---------- derived stats ---------- */

function unitsByDay() {
  const map = new Map();
  for (const d of state.drinks) {
    const key = dayKey(d.logged_at);
    const prev = map.get(key) || { units: 0, calories: 0, count: 0 };
    map.set(key, {
      units: prev.units + d.units,
      calories: prev.calories + d.calories,
      count: prev.count + 1,
    });
  }
  return map;
}

function computeStats() {
  const byDay = unitsByDay();
  const weekStart = startOfWeek();
  const today = startOfToday();

  let weekUnits = 0;
  let weekKcal = 0;
  let weekDrinks = 0;
  let dryDays = 0;

  // Only count days that have already happened toward "dry days".
  const daysElapsed = Math.round((today - weekStart) / 86400000) + 1;
  for (let i = 0; i < daysElapsed; i++) {
    const day = byDay.get(dayKey(addDays(weekStart, i)));
    if (!day) {
      dryDays++;
      continue;
    }
    weekUnits += day.units;
    weekKcal += day.calories;
    weekDrinks += day.count;
  }

  const todayEntry = byDay.get(dayKey(today));

  // Alcohol-free streak: consecutive empty days ending yesterday (or today if dry
  // so far, which we surface without claiming the day is over). Bounded by the
  // span since the first logged drink, so an empty log reads 0 rather than
  // claiming a year-long streak nobody earned.
  let streak = 0;
  if (state.drinks.length) {
    const earliest = new Date(state.drinks[state.drinks.length - 1].logged_at);
    earliest.setHours(0, 0, 0, 0);
    const span = Math.round((today - earliest) / 86400000) + 1;
    for (let i = 0; i < span; i++) {
      const day = byDay.get(dayKey(addDays(today, -i)));
      if (day && day.units > 0) break;
      streak++;
    }
  }

  const fourWeeksAgo = addDays(today, -27);
  const recent = state.drinks.filter((d) => new Date(d.logged_at) >= fourWeeksAgo);
  const fourWeekAvg = recent.reduce((sum, d) => sum + d.units, 0) / 4;

  const thirtyDaysAgo = addDays(today, -29);
  const counts = new Map();
  for (const d of state.drinks) {
    if (new Date(d.logged_at) < thirtyDaysAgo) continue;
    counts.set(d.category, (counts.get(d.category) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    byDay,
    weekUnits,
    weekKcal,
    weekDrinks,
    dryDays,
    todayUnits: todayEntry?.units || 0,
    streak,
    fourWeekAvg,
    topCategory: top ? top[0] : null,
  };
}

/* ---------- render ---------- */

function render() {
  const s = computeStats();
  renderHero(s);
  renderChart(s.byDay);
  renderStats(s);
  renderHistory();
  $("#weekly-limit").value = state.settings.weekly_limit;
}

function renderHero(s) {
  const limit = state.settings.weekly_limit;
  const circumference = 2 * Math.PI * 52;
  const ratio = limit > 0 ? Math.min(s.weekUnits / limit, 1) : s.weekUnits > 0 ? 1 : 0;

  const ring = $("#ring-value");
  ring.style.strokeDashoffset = String(circumference * (1 - ratio));
  ring.classList.toggle("over", limit > 0 && s.weekUnits > limit);

  $("#week-units").textContent = fmtUnits(s.weekUnits);
  $("#today-units").textContent = fmtUnits(s.todayUnits);
  $("#week-drinks").textContent = s.weekDrinks;
  $("#week-kcal").textContent = Math.round(s.weekKcal).toLocaleString();

  const line = $("#week-line");
  const weekLabel = startOfWeek().toLocaleDateString(undefined, { month: "short", day: "numeric" });

  if (limit <= 0) {
    line.innerHTML = `Since Monday ${weekLabel}. No weekly limit set — <b>tracking only</b>.`;
  } else if (s.weekUnits > limit) {
    const over = s.weekUnits - limit;
    line.innerHTML = `Since Monday ${weekLabel}. You're <b class="over">${fmtUnits(over)} over</b> your ${limit}-unit limit.`;
  } else {
    const left = limit - s.weekUnits;
    line.innerHTML = `Since Monday ${weekLabel}. <b class="good">${fmtUnits(left)} left</b> of your ${limit}-unit limit.`;
  }
}

function renderChart(byDay) {
  const chart = $("#chart");
  chart.textContent = "";

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const date = addDays(startOfToday(), -i);
    days.push({ date, units: byDay.get(dayKey(date))?.units || 0 });
  }

  const peak = Math.max(...days.map((d) => d.units), 1);
  const todayKey = dayKey(new Date());

  for (const day of days) {
    const isToday = dayKey(day.date) === todayKey;

    const col = document.createElement("div");
    col.className = `bar-col${isToday ? " is-today" : ""}`;

    const wrap = document.createElement("div");
    wrap.className = "bar-wrap";

    const bar = document.createElement("div");
    bar.className = `bar${day.units === 0 ? " zero" : ""}${isToday && day.units > 0 ? " today" : ""}`;
    bar.style.height = day.units === 0 ? "3px" : `${Math.max((day.units / peak) * 100, 6)}%`;
    bar.title = `${day.date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} — ${fmtUnits(day.units)} units`;

    wrap.append(bar);

    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = day.date.toLocaleDateString(undefined, { weekday: "narrow" });

    col.append(wrap, label);
    chart.append(col);
  }
}

function renderStats(s) {
  $("#stat-streak").textContent = s.streak;
  $("#stat-dry").textContent = s.dryDays;
  $("#stat-avg").textContent = fmtUnits(s.fourWeekAvg);

  const top = $("#stat-top");
  top.classList.add("small");
  top.textContent = s.topCategory
    ? `${CATEGORY_EMOJI[s.topCategory]} ${s.topCategory[0].toUpperCase()}${s.topCategory.slice(1)}`
    : "—";
}

function renderHistory() {
  const container = $("#history");
  container.textContent = "";

  $("#history-count").textContent = state.drinks.length
    ? `${state.drinks.length} entr${state.drinks.length === 1 ? "y" : "ies"}`
    : "";

  if (!state.drinks.length) {
    container.append(
      emptyState("🍸", "Nothing logged yet. Tap a quick-add above and it'll show up here."),
    );
    return;
  }

  const groups = new Map();
  for (const drink of state.drinks) {
    const key = dayKey(drink.logged_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(drink);
  }

  for (const [key, drinks] of groups) {
    const group = document.createElement("div");
    group.className = "day-group";

    const head = document.createElement("div");
    head.className = "day-head";

    const name = document.createElement("span");
    name.className = "day-name";
    name.textContent = relativeDayName(key);

    const total = document.createElement("span");
    total.className = "day-total";
    total.textContent = `${fmtUnits(drinks.reduce((sum, d) => sum + d.units, 0))} units`;

    head.append(name, total);
    group.append(head);

    for (const drink of drinks) group.append(entryRow(drink));
    container.append(group);
  }
}

function entryRow(drink) {
  const row = document.createElement("div");
  row.className = "entry";

  const emoji = document.createElement("div");
  emoji.className = "entry-emoji";
  emoji.textContent = CATEGORY_EMOJI[drink.category] || "🍹";
  emoji.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "entry-body";

  const name = document.createElement("div");
  name.className = "entry-name";
  name.textContent = drink.name;

  const time = new Date(drink.logged_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sub = document.createElement("div");
  sub.className = "entry-sub";
  sub.textContent = [
    time,
    `${Math.round(drink.volume_ml)} ml`,
    `${drink.abv}%`,
    `${drink.calories} kcal`,
    drink.note,
  ]
    .filter(Boolean)
    .join(" · ");

  body.append(name, sub);

  const units = document.createElement("div");
  units.className = "entry-units";
  units.textContent = fmtUnits(drink.units);

  const del = document.createElement("button");
  del.className = "entry-del";
  del.type = "button";
  del.setAttribute("aria-label", `Delete ${drink.name}`);
  del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`;
  del.addEventListener("click", () => deleteDrink(drink));

  row.append(emoji, body, units, del);
  return row;
}

function emptyState(emoji, message) {
  const el = document.createElement("div");
  el.className = "empty";
  el.innerHTML = `<span class="empty-emoji" aria-hidden="true">${emoji}</span><p></p>`;
  el.querySelector("p").textContent = message;
  return el;
}

function renderLoadFailure(message) {
  $("#history").replaceChildren(emptyState("⚠️", message));
  $("#week-line").textContent = "Couldn't reach the server. Refresh to try again.";
  $("#week-units").textContent = "—";
}

/* ---------- actions ---------- */

async function addDrink(payload, { quiet = false } = {}) {
  try {
    const created = await api("/api/drinks", { method: "POST", body: JSON.stringify(payload) });
    // Keep the in-memory list sorted newest-first, same as the server returns it.
    state.drinks.unshift(created);
    state.drinks.sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at));
    render();
    if (!quiet) toast(`${created.name} logged · ${fmtUnits(created.units)} units`);
    return created;
  } catch (err) {
    toast(err.message, { error: true });
    return null;
  }
}

async function deleteDrink(drink) {
  try {
    await api(`/api/drinks/${drink.id}`, { method: "DELETE" });
    state.drinks = state.drinks.filter((d) => d.id !== drink.id);
    render();
    toast(`Deleted ${drink.name}`, {
      action: {
        label: "Undo",
        // Re-post rather than resurrect the row, so the original timestamp survives.
        onClick: () =>
          addDrink(
            {
              name: drink.name,
              category: drink.category,
              volume_ml: drink.volume_ml,
              abv: drink.abv,
              note: drink.note,
              logged_at: drink.logged_at,
            },
            { quiet: true },
          ),
      },
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/* ---------- wiring ---------- */

function buildPresets() {
  const grid = $("#preset-grid");
  for (const preset of PRESETS) {
    const { units } = derive(preset.volume_ml, preset.abv, preset.category);

    const btn = document.createElement("button");
    btn.className = "preset";
    btn.type = "button";
    btn.innerHTML = `
      <span class="preset-top"><span class="preset-emoji" aria-hidden="true">${CATEGORY_EMOJI[preset.category]}</span></span>
      <span class="preset-sub"></span>
      <span class="preset-units">${fmtUnits(units)} units</span>`;
    btn.querySelector(".preset-top").append(preset.name);
    btn.querySelector(".preset-sub").textContent = `${preset.volume_ml} ml · ${preset.abv}%`;
    btn.addEventListener("click", () => addDrink({ ...preset }));

    grid.append(btn);
  }
}

function localDatetimeValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function updateLiveCalc() {
  const volume = Number($("#f-volume").value);
  const abv = Number($("#f-abv").value);
  const category = $("#f-category").value;

  if (!Number.isFinite(volume) || !Number.isFinite(abv) || volume <= 0) {
    $("#live-calc").textContent = "Enter a volume and ABV";
    return;
  }
  const { units, calories } = derive(volume, abv, category);
  $("#live-calc").textContent = `≈ ${fmtUnits(units)} units · ${calories} kcal`;
}

function wireForm() {
  const form = $("#drink-form");
  $("#f-when").value = localDatetimeValue();

  for (const id of ["#f-volume", "#f-abv", "#f-category"]) {
    $(id).addEventListener("input", updateLiveCalc);
  }
  updateLiveCalc();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));

    const created = await addDrink({
      name: data.name.trim(),
      category: data.category,
      volume_ml: Number(data.volume_ml),
      abv: Number(data.abv),
      note: data.note.trim(),
      // datetime-local has no timezone; parsing it as local is what the user meant.
      logged_at: data.logged_at ? new Date(data.logged_at).toISOString() : undefined,
    });

    if (created) {
      form.reset();
      $("#f-volume").value = 355;
      $("#f-abv").value = 5;
      $("#f-when").value = localDatetimeValue();
      updateLiveCalc();
      $("#f-name").focus();
    }
  });
}

function wireSettings() {
  const panel = $("#settings-panel");
  const toggle = $("#settings-toggle");

  toggle.addEventListener("click", () => {
    const open = panel.hasAttribute("hidden");
    panel.toggleAttribute("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
    if (open) $("#weekly-limit").focus();
  });

  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const value = Number($("#weekly-limit").value);
      state.settings = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ weekly_limit: value }),
      });
      render();
      toast("Weekly limit saved");
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  $("#clear-data").addEventListener("click", async () => {
    if (!confirm("Delete every logged drink? This can't be undone.")) return;
    try {
      await api("/api/drinks", { method: "DELETE" });
      state.drinks = [];
      render();
      toast("All data cleared");
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

buildPresets();
wireForm();
wireSettings();
load();
