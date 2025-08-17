import OpenAI from "openai";
import "dotenv/config";

const embedClient = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL_EMBED,
    apiKey: "not-needed"
});

const EMBED_MODEL = process.env.EMBED_MODEL!;

export async function embedBatch(texts: string[], batchSize = 64): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        const r = await embedClient.embeddings.create({
            model: EMBED_MODEL,
            input: chunk,
        });
        for (const item of r.data) out.push(item.embedding as unknown as number[]);
    }
    return out;
}

export async function embedOne(text: string): Promise<number[]> {
    const r = await embedClient.embeddings.create({
        model: EMBED_MODEL,
        input: text,
    });
    return r.data[0].embedding as unknown as number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let aNorm = 0;
    let bNorm = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        aNorm += a[i] * a[i];
        bNorm += b[i] * b[i];
    }
    return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm) + 1e-9); 
}