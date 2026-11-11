# Eval sample (synthetic)

Everything in this folder is invented: 31 fictional job postings from fictional companies (example.com URLs), gold labels written by hand for them, and the invented entry-level candidate from `profile.example.json` at the repo root (Jordan Rivera, Chicago; the postings are located accordingly). No row comes from a real posting or a real person.

## What the published numbers are, and what this is

The accuracy, precision@10, recall and track-accuracy figures in the main README were measured on **one candidate's private labels** and real postings. That data is kept local (`eval/private/`, not in the repository), so a fresh clone cannot reproduce those numbers.

This sample does **not** reproduce them and says nothing about how good the scorer is. It only shows how the harness runs end to end: load gold labels and frozen postings, split dev / held-out by hash, run k trials per job, compute metrics, write result files.

## Files

- `candidates.jsonl` - frozen postings (`key`, `stratum`, `snapshot` with title, company, description, ...).
- `gold.jsonl` - one label per posting: `apply` / `maybe` / `skip`, track `A` / `B`, plus the verbatim requirement sentence behind the label (same schema as the real gold file).
- The candidate profile is not stored here: the sample uses `profile.example.json` (repo root). Drop a `profile.json` in this folder to override it.
- `results/` - written by the scripts (ignored by git).

## Run it (no API key, no network)

    npm run eval -- --sample --fake-llm --split all

`--fake-llm` swaps the model for a deterministic keyword rule (`src/eval/fakeLlm.ts`). It is deliberately imperfect, so a few postings are scored "wrong" and the metrics are not all 1.0. With a real key, drop `--fake-llm` and the same command scores the sample with the real model.

## How the data directory is chosen

1. `EVAL_DIR=<dir>` if set.
2. `--sample` on the command line: this folder.
3. `eval/private/` if it exists (the owner's real data).
4. Otherwise this folder.

Results go to `<data dir>/results/`.
