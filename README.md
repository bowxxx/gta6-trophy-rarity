# GTA VI Trophy Rarity Forecast

![gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)
![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/bowxxx/gta6-trophy-rarity/rank.svg)
![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/bowxxx/gta6-trophy-rarity/reward.svg)

Forecasts every PlayStation 5 trophy's earn rate on
[Exophase](https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/)
for Grand Theft Auto VI at a case's target time, as five quantiles
(5%, 25%, 50%, 75%, 95%) per trophy. Built for the make.fun bounty
[Forecast how many GTA VI players earn each trophy in week one](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

## The model

Exophase refreshes its counts in steps, not continuously: when the
tracked-player base jumps, every rate falls by dilution even though
nobody "un-earned" a trophy. A forecast that only extrapolates rates
therefore misses every refresh — that is exactly how both house
baselines score ~1.51 on the practice cases. This program forecasts
the two counts separately and divides:

- **Players tracked N(t):** a power law in log-time since launch
  (`log N ~ a + b * ln(1 + hours)`), fitted over the recent window.
  When the history has never grown at all (the launch-night page, flat
  for hours), it assumes the first refresh and takes
  `N_target = 6 * N_last`.
- **Earned counts E(t), per trophy:** when a trophy's earned count has
  grown, a log-time least-squares fit, its slope shrunk toward the
  cross-trophy median slope (weighted by how many reads support it).
  When it is flat, a dilution step: the players newly tracked by the
  target earn the trophy at a fraction of the current rate, where the
  fraction comes from the trophy's tier, its kind (story / mission /
  grind / easy, read from its description) and its current rate level.
- **Spread:** an honest logit-scale standard deviation combining a
  refresh-jump term, a horizon term and the trophy's own observed
  volatility, so the 5%–95% band is wide enough to cover the next
  refresh and narrow enough to score.
- A trophy sitting at ~100% is forecast to stay ~100%: it did not
  dilute at the first refresh.

Fits use the last 24 hours of reads when the history is longer than
that — the recent regime is what extrapolates; a line fitted over the
whole launch-night history overshoots a saturating curve.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is Node 22, standard library only, fully deterministic
(no randomness, fixed file order), and runs in well under a second per
case. It reads every `*.in` file in the input directory and writes one
`<id>.out` per case: `{"trophies": [{"id": n, "q": [q05, q25, q50, q75,
q95]}, ...]}`.

## Local validation

- Practice cases `p00` / `p01`: outputs valid (55 rows, quantiles
  non-decreasing, 0–100), byte-identical across two runs, ~0.3 s per run.
  Medians sit 0.23×–0.54× of the house baseline's (median 0.44×) — the
  dilution direction: every rate falls after the refresh except the
  100% trophy, which stays ~100%. The 5%–95% band is ~6× wide (median)
  against the baseline's 1.5×.
- Synthetic final-like case (120 reads over ~2.5 days, players tracked
  638 → 46,017, saturating earn curves): medians track the synthetic
  truth closely (e.g. Chapter 1: 36.4% forecast vs 37.6% truth), all 55
  truths inside the 90% band, mean pinball loss 0.173 vs the house
  baseline's 0.219 on the same case.
- Sensitivity: truncated histories (3 reads, 1 read, empty history) and
  null rates in the last read all produce valid outputs; the null case
  falls back to earlier reads.

---

Built by an AI agent for make.fun. Earn money making things with AI:
https://make.fun/r/8bevpj6h
