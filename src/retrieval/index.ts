import fs from "fs/promises";
import winkBM25 from "wink-bm25-text-search";
import type { Chunk } from "./chunk.js";
import { embedOne, cosineSimilarity } from "../embed.js";

type Store = { chunks: Chunk[]; embeddings: number[][]; bm25: any };
let STORE: Store;
let BM: any;

export async function loadStore(path: string) {
    const raw = JSON.parse(await fs.readFile(path, "utf8"));
    STORE = raw;

    BM = winkBM25();
    BM.import(raw.bm25);
}

export type Retrieved = {
    chunk: Chunk;
    bm25: number;
    ann: number;
    score?: number 
};

export async function searchHybrid(
    query: string,
    bmN = 100,
    annN = 200
): Promise<Retrieved[]> {
    // BM25
    const bmHits = BM.search(query).slice(0, bmN);
    const bmMap = new Map<string, number>();
    for (const h of bmHits) bmMap.set(h.id, h.score);

    // ANN via embeddings
    const qvec = await embedOne(query);
    const sims = STORE.embeddings
        .map((vec: number[], idx: number) => ({
            id: STORE.chunks[idx].id,
            score: cosineSimilarity(qvec, vec),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, annN);
    const annMap = new Map(sims.map((h) => [h.id, h.score]));

    // union + simple fusion (normalize & sum)
    const ids = new Set([...bmMap.keys(), ...annMap.keys()]);
    const combined: Retrieved[] = [];
    for (const id of ids) {
        const chunk = STORE.chunks[STORE.chunks.findIndex((c) => c.id === id)];
        combined.push({
            chunk,
            bm25: bmMap.get(id) ?? 0,
            ann: annMap.get(id) ?? 0,
        });
    }
    const bmVals = combined.map((x) => x.bm25);
    const annVals = combined.map((x) => x.ann);
    
    const norm = (v: number, a: number[], eps = 1e-9) =>
        (v - Math.min(...a)) / (Math.max(...a) - Math.min(...a) + eps);

    for (const r of combined)
        r.score = 0.5 * norm(r.bm25, bmVals) + 0.5 * norm(r.ann, annVals);

    return combined.sort((a, b) => b.score! - a.score!);
}

export async function rerankCrossEncoder(
    query: string,
    cands: Retrieved[],
    k = 50
) {
    return cands.slice(0, k);
}


