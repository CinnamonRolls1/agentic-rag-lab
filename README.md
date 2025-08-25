## Agentic RAG Lab

Minimal, fast agentic RAG with:
- Hybrid retrieval (BM25 + FAISS) with optional cross-encoder rerank
- Plan selection (single, multi, needs_calc, needs_sql)
- Math tool (exact expression evaluation)
- SQL tool over CSVs via DuckDB, with LLM-assisted table selection/querying
- Citation-first synthesis + light claim verification (NLI) and auto-widening
- Streaming answers with TTFT and simple Web UI + API

### Layout
- `datasets/`: raw downloads (SQuAD, HotpotQA, WikiSQL tarball)
- `data/`: processed runtime artifacts
  - `data/docs/`: plain-text corpus from SQuAD/Hotpot
  - `data/tables/`: CSVs from WikiSQL (auto-loaded into DuckDB)
- `data/retrieval/`: FAISS index + metadata (`index.faiss`, `metadata.json`)
- `src/tools/`: DuckDB + table index builder, math tool

### Requirements
- Node 18+
- macOS/Linux (faiss-node prebuilds supported)

### Environment
Set these in `.env` or your shell:
- `LM_BASE_URL`: OpenAI-compatible endpoint (e.g., LM Studio or OpenAI)
- `LM_API_KEY`: API key for the endpoint
- `LM_MODEL`: chat/completions model (used for planning, generation, NLI)
- `EMBED_MODEL`: embedding model for FAISS indexing/search
- `RERANK_MODEL` (optional): ms-marco-style embedding model for rerank
- `PORT` (optional): web server port (default 3000)

### Install
```bash
npm install
```

### Prepare data (downloads ~ few hundred MB)
```bash
npm run prep:all
# or run individually: prep:squad, prep:hotpot, prep:wikisql, prep:merge
```

### Build indexes
```bash
# 1) Build text index (FAISS + BM25 metadata) and 2) build table index for SQL tool
npm run index
```

### Run (CLI)
```bash
LM_BASE_URL=... LM_API_KEY=... LM_MODEL=... EMBED_MODEL=... \
npx tsx src/index.ts "Summarize key themes with citations."
```

### Run (Web UI)
```bash
npm run web
# open http://localhost:3000
```

### API
```bash
curl -s http://localhost:3000/api/ask \
  -H 'content-type: application/json' \
  -d '{"question":"Which sections discuss X? Cite passages."}' | jq .
```

### Evaluation
Quick run (limit cases):
```bash
EVAL_LIMIT=20 npm run eval
# or: npm run eval -- --limit=20
```
Full run:
```bash
npm run eval
```
Outputs a recall@k proxy, latencies (p50/p95), and retrieval IDs per question.

Notes
- Size: prep builds ~380 total cases (≈200 SQuAD + ≈120 Hotpot + ≈60 WikiSQL). The runner evaluates document-grounded cases by default; SQL-only cases are skipped in recall@k.
- Runtime: end-to-end with LLMs can be long; use `EVAL_LIMIT` for a quick sanity check.

### What happens under the hood
1) Plan selection: `single | multi | needs_calc | needs_sql`
2) Retrieval: BM25 + FAISS (requires embeddings); optional cross-encoder rerank
3) Tools (conditional): math or DuckDB SQL (tables auto-loaded from `data/tables/`)
4) Draft answer with citations; extract claims; NLI verify; widen context and re-synthesize if weak
5) Stream answer + trace (timings, citations, tool calls)

### Sample questions (exercise features)
- Single (doc retrieval):
  - Who killed King Harold II at the Battle of Hastings?
- Multi-hop-ish (combine facts):
  - In the Norman context, who considered England their most important holding, and which language did Anglo‑Norman become distinct from?
- Needs calc (math tool):
  - Compute (12.5 - 3.2) * 4 + 7.
- Needs SQL (DuckDB on WikiSQL tables):
  - How many players are listed for Toronto in the 2005-06 season?
- Not answerable / out‑of‑scope:
  - What is the weather in San Francisco right now?

Tip: For SQL, you can also ask natural language like "count players by team"; the system selects relevant tables and generates a query. Tables are derived from WikiSQL CSVs; names depend on dataset contents.

### Scripts
- `npm run prep:*`: download and build corpora and tables
- `npm run index`: build FAISS and table index
- `npm run web`: start Web UI/API
- `npm run eval`: run quick eval over bundled sets

### Troubleshooting
- FAISS/embeddings: ensure `EMBED_MODEL` reachable via `LM_BASE_URL`; artifacts are stored under `data/retrieval/`
- Rerank disabled: set `LM_BASE_URL` and `RERANK_MODEL` (logs will note fallback)
- DuckDB: CSVs must exist in `data/tables/` (created by prep). Re-run `npm run index` after adding CSVs
