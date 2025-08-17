import OpenAI from "openai";
import "dotenv/config";

export const openai = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: "not-needed"});

export const MODEL = process.env.LMMODEL!;

export async function classifyPlan(question: string) {
    const sys = `You are a planner. Output exactly one label:
    - single
    - multi
    - needs_calc
    - not_answerable
    If multiple apply, choose the most specific one. Only output the label.`;

    const r = await openai.chat.completions.create({
        model: MODEL,
        messages: [
            {role: "system", content: sys},
            {role: "user", content: question}
        ],
        temperature: 0
    });

    const label =r.choices[0]?.message?.content?.trim().toLowerCase() as "single" | "multi" | "needs_calc" | "not_answerable";
    if (label === "single") {
        return "single";
    }
}

export async function extractClaims(draft: string): Promise<string[]> {
    const sys = `Extract the atomic factual claims (no opinions). Return a JSON array of short strings.`;
    const r = await openai.chat.completions.create({
        model: MODEL,
        messages: [
            {role: "system", content: sys},
            {role: "user", content: draft}
        ],
        temperature: 0
    });
    try {
        return JSON.parse(r.choices[0]!.message!.content!);
    } catch {
        return [];
    }
}

export async function nliSupports(claims: string, context: string) {
    const sys = `Decide if the context supports the claim. 
    Answer with JSON: {"support": "yes"|"no", "prob": 0..1}. 
    Only use the context provided.`;

    const r = await openai.chat.completions.create({
        model: MODEL, 
        messages: [
            { role: "system", content: sys },
            { role: "user", content: `CONTEXT: ${context}\n\nCLAIM: ${claims}` }
        ],
        temperature: 0
    });
    try {
        return JSON.parse(r.choices[0]!.message!.content!);
    } catch {
        return { support: "no", prob: 0 };
    }
}

export async function synthesizeAnswer(question: string, context: string, citeMap: Record<string, string>): Promise<string> {
    const sys = `Answer using ONLY the provided CONTEXT.
    - Quote verbatim short phrases.
    - Add citations like [CIT:chunkId].
    - If insufficient evidence, say so explicitly.`;
    const r = await openai.chat.completions.create({
        model: MODEL,
        messages: [
            { role: "system", content: sys },
            { role: "user", content: `CONTEXT: ${context}\n\nQUESTION: ${question}` }
        ],
        temperature: 0.2
    });

    let text = r.choices[0]!.message!.content! || "";
    
    Object.keys(citeMap)
    .slice(0, 3)
    .forEach((id) => {
        if (!text.includes(`[CIT:${id}]`)) text += ` [CIT:${id}]`;
    });
    return text;
}

export async function streamWithTTFT(
    messages: any[],
    tools?: any[]
): Promise<{ text:string; ttft_ms: number; toks_per_s: number}> {
    const start = performance.now();
    const stream = await openai.chat.completions.create({
        model: MODEL,
        stream: true,
        messages,
        ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" as const } : {})
      });
    let first = -1;
    let tokens = 0;
    let text = "";
    for await (const part of stream) {
        const delta = part.choices?.[0]!.delta?.content ?? "";
        if (delta) {
            tokens += 1;
            text += delta;
            if (first < 0) first = performance.now();
        }
    }
    const end = performance.now()
    return {
        text,
        ttft_ms: first > 0 ? end - first : -1,
        toks_per_s: tokens > 0 ? tokens / ((end - first) / 1000) : 0
    };
}
