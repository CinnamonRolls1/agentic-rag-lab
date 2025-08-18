import { runAgent } from "./pipeline.js";
import { initDuckDB } from "./tools/sql.js";

const q = process.argv.slice(2).join(" ") || "Summarize the key themes across these docs with citations.";
await initDuckDB(); 

const { trace } = await runAgent(q);

console.log("\n=== ANSWER ===\n" + trace.answer);
console.log("\n=== METRICS ===");
console.table({
    plan: trace.plan,
    ttft_ms: Math.round(trace.ttft_ms),
    toks_per_s: Math.round(trace.toks_per_s * 10) / 10,
    retrieval_ms: Math.round(trace.retrieval.took_ms),
    agent_overhead_ms: Math.round(trace.total_ms - trace.retrieval.took_ms),
    claims: trace.verify.claims,
    supported: trace.verify.supported,
    attrP: Math.round(trace.verify.p * 100) / 100,
});
console.log("Citations:", trace.retrieval.ids.join(", "));
