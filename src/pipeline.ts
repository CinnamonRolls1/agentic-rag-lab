import { performance } from "node:perf_hooks";
import { classifyPlan, extractClaims, nliSupports, synthesizeAnswer, openai, MODEL, streamWithTTFT } from "./lm.js";
import { loadStore, searchHybrid, rerankCrossEncoder } from "./retrieval/index.js";
import type { Retrieved } from "./retrieval/index.ts";

import { code_eval } from "./tools/code.js";

export type Trace = {
    plan: string;
    retrieval: { took_ms: number; k: number; ids: string[] };
    tools: { name: string; ok: boolean; took_ms: number };
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
                }
            ],
            messages: [
                { role: "system", content: "You may call tools like code_eval as needed. If unnecessary, just answer." },
                { role: "user", content: `QUESTION: ${question}\nCONTEXT:\n${contextStr}\nIf the question requires simple math execution, call code_eval.` }
              ]
        });

        const call = r.choices[0]?.message?.tool_calls?.[0];
        if (call) {
            const tS = performance.now();
            let result = "";
            if (call.function.name === "code_eval") {
                result = code_eval(JSON.parse(call.function.arguments || "{}"));
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
        { role: "system", content: "Answer strictly from CONTEXT: quote short phrases and include [CIT:chunkId] where appropriate." }
    ]
}