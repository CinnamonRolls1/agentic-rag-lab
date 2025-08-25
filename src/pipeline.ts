import { performance } from "node:perf_hooks";
import { classifyPlan, extractClaims, nliSupports, synthesizeAnswer, openai, MODEL, streamWithTTFT, decomposeQuestion } from "./lm.js";
import { loadStore, searchHybrid, searchBM25, rerankCrossEncoder } from "./retrieval/index.js";
import type { Retrieved } from "./retrieval/index.js";

// Configuration for context sizes and behavior
const CTX_TOP_K_FOR_RENDER = 6;       // how many chunks to render in initial context string
const CTX_TOP_K_FOR_TRACE = 6;        // how many chunks to include in trace.retrieval
const CTX_TOP_K_FOR_VERIFY = 3;       // evidence size for initial verification
const CTX_TOP_K_FOR_REVERIFY = 4;     // evidence size for post-widening verification
const CTX_TOP_K_FOR_WIDENED_SYN = 10; // context size when synthesizing a widened answer
const ENFORCED_CITATIONS_TOP_K = 3;   // how many top chunk ids to enforce in synthesized answer
const ENABLE_SQL_FALLBACK_IN_SINGLE = false; // whether to allow SQL fallback in 'single' plan
const MAX_CHARS_PER_CHUNK = 500;      // limit each chunk's text to avoid prompt overflow

import { math_eval } from "./tools/math.js";
import {
    duckdb_sql,
    initDuckDB,
    loadTableIndex,
    selectRelevantTables,
    buildGenericQuery,
    type TableInfo,
} from "./tools/sql.js";

async function executeWithTiming<T>(
    toolName: string,
    toolsTrace: Trace["tools"],
    execution: () => Promise<T>
): Promise<T> {
    const tS = performance.now();
    const result = await execution();
    const tE = performance.now();
    const resultStr = String(result);
    toolsTrace.push({
        name: toolName,
        ok: !resultStr.startsWith("ERROR"),
        took_ms: tE - tS,
    });
    return result;
}

function extractMathExpression(question: string): string | null {
	// Consider only contiguous spans containing math characters (no letters)
	const candidateRegex = /[0-9+\-*/%^().\s]+/g;

	const isBalancedParens = (s: string): boolean => {
		let depth = 0;
		for (const ch of s) {
			if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth < 0) return false;
			}
		}
		return depth === 0;
	};

	const hasOperator = (s: string): boolean => /[+\-*/%^]/.test(s);
	const countNumbers = (s: string): number => (s.match(/-?\d*\.?\d+/g) || []).length;
	const hasEmptyParens = (s: string): boolean => /\(\s*\)/.test(s);

	let best: string | null = null;
	for (const segment of question.match(candidateRegex) || []) {
		const raw = segment.trim();
		if (!raw) continue;

		// Validate candidate: at least two numbers and an operator or parentheses, balanced parens, non-empty groups
		const nums = countNumbers(raw);
		const validStructure = (hasOperator(raw) || /[()]/.test(raw));
		if (nums >= 2 && validStructure && isBalancedParens(raw) && !hasEmptyParens(raw)) {
			if (!best || raw.length > best.length) best = raw;
		}
	}

	return best;
}

export type Trace = {
    plan: string;
    retrieval: { took_ms: number; k: number; ids: string[]; items: { id: string; docId: string; text: string }[] };
    tools: { name: string; ok: boolean; took_ms: number }[];
    verify: { claims: number; supported: number; p: number };
    ttft_ms: number;
    toks_per_s: number;
    total_ms: number;
    answer: string;
    multi?: { subquestions: string[]; perHop: { subq: string; ids: string[] }[] };
};

function ctxToString(reranked: Retrieved[], k = 6) {
    return reranked
        .slice(0, k)
        .map((r) => {
            const t = r.chunk.text || "";
            const clipped = t.length > MAX_CHARS_PER_CHUNK ? t.slice(0, MAX_CHARS_PER_CHUNK) : t;
            return `[${r.chunk.id}] ${clipped}`;
        })
        .join("\n---\n");
}

export async function runAgent(question: string) {
    const t0 = performance.now();
    await loadStore();
    await initDuckDB();

    let plan = "single" as string | undefined;
    try {
        plan = await classifyPlan(question);
    } catch {}
    if (!plan) plan = "single";

    const r0 = performance.now();
    let cands = await searchHybrid(question, 200, 400);
    cands = await rerankCrossEncoder(question, cands, 20);
    let contextStr = ctxToString(cands, CTX_TOP_K_FOR_RENDER);
    const r1 = performance.now();

    const toolsTrace: Trace["tools"] = [];
    let toolMsg: any[] = [];
    let toolContextText = "";
    let preDraft: string | null = null;
    let toolSuccess = false;

    // Auto-fallback: if no relevant docs found, optionally try SQL with relevant tables
    if (plan === "single" && ENABLE_SQL_FALLBACK_IN_SINGLE) {
        const hasRelevantInfo = cands.slice(0, CTX_TOP_K_FOR_VERIFY).some(
            (c) => c.chunk.text.length > 50 // Basic check for substantial content
        );

        if (!hasRelevantInfo) {
            try {
                const allTables = await loadTableIndex();
                const relevantTables = await selectRelevantTables(question, allTables);

                if (relevantTables.length > 0) {
                    const table = relevantTables[0]; // Use most relevant table
                    const query = await buildGenericQuery(question, table);

                    const result = await executeWithTiming("duckdb_sql", toolsTrace, () => duckdb_sql({ sql: query }));

                    if (!result.startsWith("ERROR")) {
                        toolMsg.push({ role: "tool", tool_call_id: "duckdb_sql#auto", content: result });
                        toolContextText += `\nduckdb_sql(${JSON.stringify(query)}): ${result}`;
                        toolSuccess = true;

                    }
                }
            } catch {}
        }
    }
    // Multi-hop: decompose and retrieve per sub-question
    let multiInfo: Trace["multi"] | undefined = undefined;
    if (plan === "multi") {
        const subqs = await decomposeQuestion(question);
        const perHop: { subq: string; cands: Retrieved[] }[] = [];
        for (const sq of subqs) {
            let hop = await searchHybrid(sq, 200, 400);
            hop = await rerankCrossEncoder(sq, hop, 12);
            perHop.push({ subq: sq, cands: hop });
        }
        // Combine and dedupe by chunk id preserving order
        const seen = new Set<string>();
        const combined: Retrieved[] = [];
        for (const h of perHop) {
            for (const r of h.cands) {
                if (!seen.has(r.chunk.id)) {
                    seen.add(r.chunk.id);
                    combined.push(r);
                }
            }
        }
        cands = combined;
        const sections = perHop.map((h) => `SUBQ: ${h.subq}\n` + ctxToString(h.cands, CTX_TOP_K_FOR_TRACE));
        contextStr = sections.join("\n\n");
        multiInfo = { subquestions: subqs, perHop: perHop.map((h) => ({ subq: h.subq, ids: h.cands.slice(0, CTX_TOP_K_FOR_TRACE).map((c) => c.chunk.id) })) };
    }

    // needs calc: try direct extraction first, then LLM approach
    if (plan === "needs_calc") {
        const mathExpr = extractMathExpression(question);
        if (mathExpr) {
            // Direct
            const result = await executeWithTiming("math_eval", toolsTrace, () =>
                Promise.resolve(math_eval({ expr: mathExpr }))
            );
            toolMsg = [{ role: "tool", tool_call_id: "math_eval#local", content: result }];
            toolContextText += `\nmath_eval(${JSON.stringify(mathExpr)}): ${result}`;
            if (!result.startsWith("ERROR")) toolSuccess = true;
        } else {
            // LLM fallback
            const r = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "math_eval",
                            parameters: {
                                type: "object",
                                properties: { expr: { type: "string" } },
                                required: ["expr"],
                            },
                        },
                    },
                ],
                messages: [
                    { role: "system", content: "Call math_eval to evaluate arithmetic expressions." },
                    { role: "user", content: `QUESTION: ${question}\nCONTEXT:\n${contextStr}` },
                ],
            });

            const call = r.choices[0]?.message?.tool_calls?.[0];
            if (call?.function?.name === "math_eval") {
                const result = await executeWithTiming("math_eval", toolsTrace, () =>
                    Promise.resolve(math_eval(JSON.parse(call.function.arguments || "{}")))
                );
                toolMsg = [{ role: "tool", tool_call_id: call.id!, content: result }];
                toolContextText += `\nmath_eval(${call.function.arguments || "{}"}): ${result}`;
                if (!result.startsWith("ERROR")) toolSuccess = true;
            }
        }
    }

    // SQL tool
    if (plan === "needs_sql") {
        const allTables = await loadTableIndex();
        const relevantTables = await selectRelevantTables(question, allTables);

        let tableDescriptions = "";

        if (relevantTables.length > 0) {
            tableDescriptions = relevantTables
                .map(
                    (table) =>
                        `\n${table.alias} (${table.domain}): ${table.description}\nColumns: ${table.columns.join(", ")}`
                )
                .join("\n");
        } else {
            // No relevant tables found - let the LLM know there's no suitable data
            tableDescriptions = "\nNo relevant tables found for this query.";
        }

        const r = await openai.chat.completions.create({
            model: MODEL,
            temperature: 0,
            tools: [
                {
                    type: "function",
                    function: {
                        name: "duckdb_sql",
                        parameters: {
                            type: "object",
                            properties: { sql: { type: "string" } },
                            required: ["sql"],
                        },
                    },
                },
            ],
            messages: [
                {
                    role: "system",
                    content: `You have access to multiple data tables via SQL. Use duckdb_sql to query the database.

Available tables:${tableDescriptions}

Always use proper SQL syntax and quote strings with single quotes. Choose the most appropriate table for the user's question.`,
                },
                { role: "user", content: `QUESTION: ${question}` },
            ],
        }); // TODO: kind of redundant, ^ should not trigger if no relevant tables

        const call = r.choices[0]?.message?.tool_calls?.[0];
        if (call?.function?.name === "duckdb_sql") {
            const result = await executeWithTiming("duckdb_sql", toolsTrace, () =>
                duckdb_sql(JSON.parse(call.function.arguments || "{}"))
            );
            toolMsg = [{ role: "tool", tool_call_id: call.id!, content: result }];
            toolContextText += `\nduckdb_sql(${call.function.arguments || "{}"}): ${result}`;
            if (!result.startsWith("ERROR")) toolSuccess = true;
        }
    }

    
    const draftPrompt = [
        {
            role: "system",
            content: `Answer the question using the provided CONTEXT and TOOL RESULTS. 
        
- For document context: quote short phrases and include [CIT:chunkId] citations
- Don't say "no information available" if tool results show data
- Tools could be SQL calls or math evaluations; you get the results directly and must choose to paraphrase or combine with the CONTEXT if any is available (only if the context is relevant, of course)
- If tools returned data conflicting with the CONTEXT, prioritize tool information for factual queries
- Your final answer must be in natural language - this may require extracting the answer from the tool results and not parroting it directly.`,
        },
        {
            role: "user",
            content: `QUESTION: ${question}\nCONTEXT:\n\n${contextStr}${
                toolContextText ? `\n\nTOOL RESULTS:\n${toolContextText}` : ""
            }`,
        },
    ] as any;
    const draftResult = preDraft
        ? { text: preDraft, ttft_ms: 0, toks_per_s: 0 }
        : await streamWithTTFT(draftPrompt);
    const { text: draft, ttft_ms, toks_per_s } = draftResult;

    const claims = draft.trim().length > 0 ? await extractClaims(draft) : [];
    let supported = 0;
    for (const c of claims) {
        const evidence = cands
            .slice(0, CTX_TOP_K_FOR_VERIFY)
            .map((x) => x.chunk.text)
            .join("\n");
        const r = await nliSupports(c, evidence);
        if (r.support === "yes" && r.prob > 0.5) supported += 1;
    }

    const attrP = claims.length ? supported / claims.length : 1;

    // improve step
    let answer = draft;
    // Track verification metrics that will be reported
    let verifyClaims = claims.length;
    let verifySupported = supported;
    let verifyP = attrP;
    if (attrP < 0.7 && !toolSuccess) {  // Don't improve when we have authoritative tool results
        const wider = ctxToString(cands, CTX_TOP_K_FOR_WIDENED_SYN);
        answer = await synthesizeAnswer(
            question,
            wider,
            Object.fromEntries(cands.slice(0, ENFORCED_CITATIONS_TOP_K).map((c) => [c.chunk.id, c.chunk.docId]))
        );

        // Re-verify the improved answer against a slightly wider top-k evidence set
        const improvedClaims = answer.trim().length > 0 ? await extractClaims(answer) : [];
        let improvedSupported = 0;
        const improvedEvidence = cands
            .slice(0, CTX_TOP_K_FOR_REVERIFY)
            .map((x) => x.chunk.text)
            .join("\n");
        for (const c of improvedClaims) {
            const r2 = await nliSupports(c, improvedEvidence);
            if (r2.support === "yes" && r2.prob > 0.5) improvedSupported += 1;
        }
        verifyClaims = improvedClaims.length;
        verifySupported = improvedSupported;
        verifyP = improvedClaims.length ? improvedSupported / improvedClaims.length : 1;
    }

    const t1 = performance.now();
    const trace: Trace = {
        plan,
        retrieval: {
            took_ms: r1 - r0,
            k: CTX_TOP_K_FOR_TRACE,
            ids: cands.slice(0, CTX_TOP_K_FOR_TRACE).map((c) => c.chunk.id),
            items: cands.slice(0, CTX_TOP_K_FOR_TRACE).map((c) => ({ id: c.chunk.id, docId: c.chunk.docId, text: c.chunk.text })),
        },
        tools: toolsTrace,
        verify: { claims: verifyClaims, supported: verifySupported, p: verifyP },
        ttft_ms,
        toks_per_s,
        total_ms: t1 - t0,
        answer,
        ...(multiInfo ? { multi: multiInfo } : {}),
    };
    return { trace };
}
