// @ts-ignore
import OpenAI from "openai";
import "dotenv/config";

function getEmbedClient() {
    return new OpenAI({
        baseURL: process.env.LM_BASE_URL,
        apiKey: process.env.LM_API_KEY
    });
}

function getEmbedModel() {
    return process.env.EMBED_MODEL as string;
}

function normalizeVector(vec: number[]): number[] {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
        norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;

    const normalized = new Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
        normalized[i] = vec[i] / norm;
    }
    return normalized;
}

export async function embedBatch(texts: string[], batchSize = 64): Promise<number[][]> {
    const out: number[][] = [];
    const client = getEmbedClient();
    const model = getEmbedModel();

    for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        const r = await client.embeddings.create({
            model: model,
            input: chunk,
        });
        for (const item of r.data) {
            const embedding = item.embedding as unknown as number[];
            out.push(normalizeVector(embedding));
        }
    }
    return out;
}

export async function embedOne(text: string): Promise<number[]> {
    const client = getEmbedClient();
    const model = getEmbedModel();

    const r = await client.embeddings.create({
        model: model,
        input: text,
    });
    const embedding = r.data[0].embedding as unknown as number[];
    return normalizeVector(embedding); 
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