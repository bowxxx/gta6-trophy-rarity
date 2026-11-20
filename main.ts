// gta6-trophy-rarity-forecast-01 — a dilution-aware trophy rarity forecast.
//
// The core fact this program is built on: Exophase refreshes its counts in
// steps, not continuously. A read shows the rates as of Exophase's last
// refresh, and when the tracked-player base jumps, every rate falls by
// dilution even though nobody "un-earned" a trophy. A forecast that only
// extrapolates rates therefore misses every refresh. So this program
// forecasts the two counts separately and divides:
//
//   * players_tracked N(t): a power law in log-time since launch,
//     log N ~ a + b * ln(1 + hours). When the history shows no growth at
//     all (the launch-night page, flat for hours), it assumes the first
//     refresh the phenomenon describes and takes N_target = 6 * N_last.
//   * earned counts E_i(t) per trophy: when a trophy's earned count has
//     grown, a log-time least-squares fit, its slope shrunk toward the
//     cross-trophy median slope (weighted by how many reads support it);
//     when it is flat, a dilution step: the players newly tracked by the
//     target earn the trophy at a fraction f_i of the current rate, where
//     f_i comes from the trophy's tier, its kind (story / mission / grind
//     / easy, read from its description) and its current rate level.
//   The median rate is E_target / N_target.
//
// The spread is an honest logit-scale sd combining a refresh-jump term, a
// horizon term and the trophy's own observed volatility, so the 5%-95%
// band is wide enough to cover the next refresh and narrow enough to
// score. A trophy sitting at ~100% is forecast to stay ~100%: it did not
// dilute at the first refresh.
//
// Deterministic: no randomness anywhere, fixed file order, fixed JSON, so
// two runs write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** First-refresh jump assumed when the history has never grown. */
const FLAT_JUMP = 6;
/** Refresh-jump uncertainty, logit sd. */
const SPREAD_BASE = 0.55;
/** Horizon random-walk term, logit sd per square-root day. */
const SPREAD_HORIZON = 0.22;
/** Cap on a trophy's own observed volatility term, logit sd. */
const SPREAD_VOL_CAP = 0.6;
/** Cap on extrapolated player growth, as a multiple of the last read. */
const N_GROWTH_CAP = 20;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number;
  rates: Array<number | null>;
}

interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const expit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Acklam's approximation to the inverse standard normal CDF. */
function invNorm(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Ordinary least squares y ~ a + b*x; null when the fit is degenerate. */
function ols(xs: number[], ys: number[]): { a: number; b: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let k = 0; k < n; k++) {
    sx += xs[k];
    sy += ys[k];
    sxx += xs[k] * xs[k];
    sxy += xs[k] * ys[k];
  }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / den;
  const a = (sy - b * sx) / n;
  return { a, b };
}

/** Kind of trophy, read from its name and description. */
function kindOf(t: Trophy): 'story' | 'mission' | 'grind' | 'easy' | 'other' {
  const d = `${t.name} ${t.description}`.toLowerCase();
  if (/chapter|final mission/.test(d)) return 'story';
  if (/complete (breakfast run|the cartel heist|child's play|headliners|vcia takedown|operation savage glory|gone fishing)/.test(d)) return 'mission';
  if (/\b(250|100|50|20|10|8|5|3)\b/.test(d) && /(stunts|vehicles|locations|challenges|races|vaults|card sets|mission strands|spots|properties)/.test(d)) return 'grind';
  if (/100% completion|each gang|all of leonida|every spot|every location|gold medal in all|250,000|100,000/.test(d)) return 'grind';
  if (/arcade game|cocktail|bowling alley|try each type|fishing challenge/.test(d)) return 'easy';
  return 'other';
}

/**
 * Fraction of the current rate at which players newly tracked by the
 * target earn this trophy. Easier trophies (higher current rate) and
 * story/mission ones are picked up faster by newcomers; grindy and
 * top-tier ones barely move.
 */
function newCohortFraction(t: Trophy, lastRate: number, medianLogit: number): number {
  let f = 0.3 + 0.12 * Math.max(-1, Math.min(1, (logit(lastRate) - medianLogit) / 1.5));
  if (t.tier === 'platinum') f -= 0.18;
  else if (t.tier === 'gold') f -= 0.12;
  else if (t.tier === 'silver') f -= 0.05;
  const k = kindOf(t);
  if (k === 'story') f += 0.1;
  else if (k === 'mission') f += 0.07;
  else if (k === 'grind') f -= 0.1;
  else if (k === 'easy') f += 0.05;
  if (t.secret) f -= 0.03;
  return Math.max(0.03, Math.min(0.65, f));
}

/** Forecast one case file; returns the rows for its output file. */
function forecast(c: CaseFile): Array<{ id: number; q: number[] }> {
  const levels = Array.isArray(c.levels) && c.levels.length > 0 ? c.levels : [0.05, 0.25, 0.5, 0.75, 0.95];
  const z = levels.map((p) => invNorm(Math.min(0.9999, Math.max(0.0001, p))));
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);
  const history = c.history ?? [];
  const trophies = c.trophies ?? [];

  // No history at all: nothing to anchor on. Flat 1% with a wide band.
  if (history.length === 0) {
    const s = 1.2;
    return trophies.map((t) => ({
      id: t.id,
      q: z.map((zz) => round4(clampPct(expit(logit(1) + zz * s)))),
    }));
  }

  // Launch: midnight UTC on the release date, else the first read.
  let launchMs = Number.NaN;
  if (c.game && typeof c.game.release_date === 'string') {
    launchMs = Date.parse(`${c.game.release_date}T00:00:00Z`);
  }
  if (!Number.isFinite(launchMs)) launchMs = Date.parse(history[0].at);
  const xOf = (ms: number): number => Math.log(Math.max(0.05, 1 + (ms - launchMs) / 3_600_000));
  const targetMs = Number.isFinite(Date.parse(c.target))
    ? Date.parse(c.target)
    : Date.parse(c.at) + c.horizon_minutes * 60_000;
  const xTarget = xOf(targetMs);

  const last = history[history.length - 1];
  const nLast = last.players_tracked > 0 ? last.players_tracked : 1;

  // Fits use the last 24 hours of reads when the history is longer than
  // that: the recent regime is what extrapolates. Early launch-night reads
  // are a steeper regime (the first refresh, the first players), and a
  // log-time line fitted over them overshoots a saturating curve badly.
  // With a short history the window is the whole history.
  const checkpointMs = Date.parse(c.at);
  const windowReads = history.filter(
    (r) => Date.parse(r.at) >= checkpointMs - 24 * 3_600_000,
  );
  const fitReads = windowReads.length >= 6 ? windowReads : history;

  // --- players_tracked model ---
  const nVals = history.map((r) => r.players_tracked).filter((n) => n > 0);
  const nMin = Math.min(...nVals);
  const nMax = Math.max(...nVals);
  const growthN = nMax > 1.15 * nMin;
  let nTarget: number;
  if (growthN) {
    const xs = fitReads.map((r) => xOf(Date.parse(r.at)));
    const ys = fitReads.map((r) => Math.log(Math.max(1, r.players_tracked)));
    const fit = ols(xs, ys);
    if (fit) {
      const b = Math.max(0, fit.b);
      nTarget = Math.exp(fit.a + b * xTarget);
    } else {
      nTarget = nLast;
    }
    nTarget = Math.min(N_GROWTH_CAP * nLast, Math.max(nLast, nTarget));
  } else {
    nTarget = nLast * FLAT_JUMP;
  }
  const jump = nTarget / nLast;

  // --- last rates, with fallbacks for missing data ---
  const lastRates: number[] = trophies.map((_, i) => {
    for (let j = history.length - 1; j >= 0; j--) {
      const r = history[j].rates[i];
      if (r !== null && r !== undefined && Number.isFinite(r)) return r;
    }
    return NaN;
  });
  const knownRates = lastRates.filter((r) => Number.isFinite(r));
  const medianRate = knownRates.length > 0 ? median(knownRates) : 1;
  const medianLogit = median(
    knownRates.filter((r) => r < 99.5).map((r) => logit(r)),
  );
  for (let i = 0; i < lastRates.length; i++) {
    if (!Number.isFinite(lastRates[i])) lastRates[i] = medianRate;
  }

  // --- per-trophy earned-count series and log-time fits ---
  interface FitInfo {
    slope: number | null;
    intercept: number;
    nObs: number;
    eLast: number;
    growing: boolean;
  }
  const fits: FitInfo[] = trophies.map((_, i) => {
    const xs: number[] = [];
    const es: number[] = [];
    // Last earned count over the whole history; the fit and the growth
    // test use the recent window only.
    let eLast = 0;
    for (const r of history) {
      const rate = r.rates[i];
      if (rate === null || rate === undefined || !Number.isFinite(rate)) continue;
      if (!(r.players_tracked > 0)) continue;
      eLast = (rate * r.players_tracked) / 100;
    }
    for (const r of fitReads) {
      const rate = r.rates[i];
      if (rate === null || rate === undefined || !Number.isFinite(rate)) continue;
      if (!(r.players_tracked > 0)) continue;
      xs.push(xOf(Date.parse(r.at)));
      es.push((rate * r.players_tracked) / 100);
    }
    const eMax = es.length > 0 ? Math.max(...es) : 0;
    const eMin = es.length > 0 ? Math.min(...es) : 0;
    const growing = es.length >= 3 && eMax > 1.15 * Math.max(eMin, 0.5);
    let slope: number | null = null;
    let intercept = 0;
    if (growing) {
      const ys = es.map((e) => Math.log(e + 0.5));
      const fit = ols(xs, ys);
      if (fit) {
        slope = fit.b;
        intercept = fit.a;
      }
    }
    return { slope, intercept, nObs: es.length, eLast, growing };
  });
  const slopes = fits
    .filter((f) => f.slope !== null)
    .map((f) => f.slope as number);
  const medianSlope = slopes.length > 0 ? median(slopes) : 0;

  // --- assemble each trophy's quantiles ---
  return trophies.map((t, i) => {
    const lastRate = lastRates[i];
    // A trophy at ~100% stayed there through the first refresh: keep it there.
    if (lastRate >= 99.5) {
      return { id: t.id, q: [99, 99.7, 99.9, 99.98, 100] };
    }

    const fit = fits[i];
    let rateMed: number;
    if (fit.growing && fit.slope !== null) {
      // Earned counts have grown: extrapolate the (shrunk) log-time fit.
      const w = fit.nObs / (fit.nObs + 10);
      const d = Math.max(0, w * fit.slope + (1 - w) * medianSlope);
      let eTarget = Math.exp(fit.intercept + d * xTarget) - 0.5;
      eTarget = Math.max(eTarget, fit.eLast);
      eTarget = Math.min(eTarget, nTarget);
      rateMed = (100 * eTarget) / nTarget;
    } else {
      // Earned counts flat: the dilution step. Newly tracked players earn
      // this trophy at a fraction f of the current rate.
      const f = newCohortFraction(t, lastRate, medianLogit);
      const eBase = fit.eLast + 0.5;
      const eTarget = Math.max(0, eBase * (1 + f * (jump - 1)) - 0.5);
      rateMed = (100 * eTarget) / nTarget;
    }

    // Observed logit volatility of this trophy's rate (sawtooth from
    // refreshes), over the recent window.
    let vol = 0;
    const diffs: number[] = [];
    let prev: number | null = null;
    for (const r of fitReads) {
      const rate = r.rates[i];
      if (rate === null || rate === undefined || !Number.isFinite(rate)) continue;
      const l = logit(rate);
      if (prev !== null) diffs.push(l - prev);
      prev = l;
    }
    if (diffs.length >= 2) {
      const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const variance = diffs.reduce((a, b) => a + (b - m) * (b - m), 0) / (diffs.length - 1);
      vol = Math.min(SPREAD_VOL_CAP, Math.sqrt(Math.max(0, variance)));
    }
    const s = Math.sqrt(
      SPREAD_BASE * SPREAD_BASE +
        (SPREAD_HORIZON * Math.sqrt(horizonDays)) ** 2 +
        vol * vol,
    );
    const centre = logit(Math.min(99.9, Math.max(0.02, rateMed)));
    let prevQ = -Infinity;
    const q = z.map((zz) => {
      const v = round4(clampPct(expit(centre + zz * s)));
      // Rounding must not break the non-decreasing order.
      const out = Math.max(v, prevQ === -Infinity ? v : prevQ);
      prevQ = out;
      return out;
    });
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  const trophies = forecast(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
