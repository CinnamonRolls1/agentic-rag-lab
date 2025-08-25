import fs from "fs/promises";
import { runAgent } from "../pipeline.js";

type DocCase = { q: string; gold_doc_ids: string[] };
const allCases: any[] = JSON.parse(await fs.readFile("src/eval/eval.json", "utf8"));

// Filter to grounded cases only (skip table only/SQL)
let cases: DocCase[] = allCases.filter((c) => Array.isArray(c?.gold_doc_ids) && typeof c?.q === "string");

// Optional limiting for quicker runs: EVAL_LIMIT env or --limit=NUM CLI arg (full run takes a 1 hr ++ @ ~30s per run on M4 pro)
const argLimit = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const limit = Number(process.env.EVAL_LIMIT || argLimit || 0);
if (Number.isFinite(limit) && limit > 0) {
    cases = cases.slice(0, limit);
}

let correct = 0, total = 0;
const latencies: number[] = [];

const p50 = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length * 0.5)] ?? 0;
const p95 = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length * 0.95)] ?? 0;

for (const c of cases) {
    const { trace } = await runAgent(c.q);
    total += 1;
    latencies.push(trace.total_ms);
  
    const hit = trace.retrieval.ids.some((id) => {
        const docId = id.split("#")[0];
        return c.gold_doc_ids.includes(docId);
    });
  
    if (hit) correct += 1;
    console.log(`${hit ? "Yes" : "No"} ${c.q}`);
}

console.log(
    `\nRecall@k proxy: ${(correct / total * 100).toFixed(1)}%  |  p50: ${Math.round(p50(latencies))}ms  p95: ${Math.round(p95(latencies))}ms`
);