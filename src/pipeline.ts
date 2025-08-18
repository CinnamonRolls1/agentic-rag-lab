import { performance } from "node:perf_hooks";
import { classifyPlan, extractClaims, nliSupports, synthesizeAnswer, openai, MODEL, streamWithTTFT } from "./lm.js";
import { loadStore, searchHybrid, rerankCrossEncoder } from "./retrieval/index.js";
import type { Retrieved } from "./retrieval/index.ts";

import { code_eval } from "./tools/code.js";
import { duckdb_sql, initDuckDB } from "./tools/sql.js";

export type Trace = {
    plan: string;
    retrieval: { took_ms: number; k: number; ids: string[] };
    tools: { name: string; ok: boolean; took_ms: number }[];
    verify: { claims: number; supported: number; p: number };
    ttft_ms: number;
    toks_per_s: number;
    total_ms: number;
    answer: string;
};

function ctxToString(reranked: Retrieved[], k = 6) {
    return reranked
        .slice(0, k)
        .map((r) => `[${r.chunk.id}] ${r.chunk.text}`)
        .join("\n---\n");
}

export async function runAgent(question: string) {
    const t0 = performance.now();
    await loadStore();
    await initDuckDB();

    const plan = await classifyPlan(question);

    const r0 = performance.now();
    let cands = await searchHybrid(question, 100, 200);
    cands = await rerankCrossEncoder(question, cands, 12);
    const contextStr = ctxToString(cands, 6);
    const r1 = performance.now();

    const toolsTrace: Trace["tools"] = [];
    let toolMsg: any[] = [];
    if (plan === "needs_calc") {
        const r = await openai.chat.completions.create({
            model: MODEL,
            temperature: 0,
            tools: [
                {
                    type: "function",
                    function: {
                        name: "code_eval",
                        parameters: {
                            type: "object",
                            properties: {
                                expr: {
                                    type: "string",
                                }
                            }, required: ["expr"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "duckdb_sql",
                        parameters: {
                            type: "object",
                            properties: {
                                sql: {
                                    type: "string",
                                }
                            }, required: ["sql"]
                        }
                    }
                }
            ],
            messages: [
                { role: "system", content: "You may call tools like code_eval and duckdb_sql as needed. If unnecessary, just answer." },
                { role: "user", content: `QUESTION: ${question}\nCONTEXT:\n${contextStr}\nIf the question requires simple math, call code_eval. If it requires executing SQL over the available CSV-backed tables, call duckdb_sql.` }
              ]
        });

        const call = r.choices[0]?.message?.tool_calls?.[0];
        if (call) {
            const tS = performance.now();
            let result = "";
            if (call.function.name === "code_eval") {
                result = code_eval(JSON.parse(call.function.arguments || "{}"));
            } else if (call.function.name === "duckdb_sql") {
                result = await duckdb_sql(JSON.parse(call.function.arguments || "{}"));
            }
            const tE = performance.now();
            toolsTrace.push({
                name: call.function.name,
                ok: result.startsWith("ERROR"),
                took_ms: tE - tS
            });
            toolMsg = [{ role: "tool", tool_call_id: call.id!, content: result }];
        }
    }

    const draftPrompt = [
        { role: "system", content: "Answer strictly from CONTEXT: quote short phrases and include [CIT:chunkId] where appropriate." },
        { role: "user", content: `QUESTION: ${question}\nCONTEXT:\n\n${contextStr}` },
        ...toolMsg
    ] as any;
    const { text: draft, ttft_ms, toks_per_s } = await streamWithTTFT(draftPrompt);

    const claims = await extractClaims(draft);
    let supported = 0;
    for (const c of claims) {
        const evidence = cands.slice(0, 3).map((x) => x.chunk.text).join("\n");
        const r = await nliSupports(c, evidence);
        if (r.support === "yes" && r.prob > 0.5) supported += 1;
    }

    const attrP = claims.length ? supported / claims.length : 1;

    // improve step
    let answer = draft;
    if (attrP < 0.7) {
        const wider = ctxToString(cands, 10);
        answer = await synthesizeAnswer(
            question,
            wider,
            Object.fromEntries(cands.slice(0, 3).map((c) => [c.chunk.id, c.chunk.docId]))
        );
    }

    const t1 = performance.now();
    const trace: Trace = {
        plan,
        retrieval: { took_ms: r1 - r0, k: 6, ids: cands.slice(0, 6).map((c) => c.chunk.id) },
        tools: toolsTrace,
        verify: { claims: claims.length, supported, p: attrP },
        ttft_ms,
        toks_per_s,
        total_ms: t1 - t0,
        answer
    };
    return { trace };
}