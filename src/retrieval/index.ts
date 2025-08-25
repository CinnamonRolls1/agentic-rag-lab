import fs from "fs/promises";
import winkBM25 from "wink-bm25-text-search";
import pkg from "faiss-node";
const { IndexFlatIP } = pkg;
import type { Chunk } from "./chunk.js";
import { embedOne, cosineSimilarity } from "../embed.js";
// @ts-ignore
import OpenAI from "openai";

type Store = { chunks: Chunk[]; faissIndex: any; bm25: any; dimension: number };
let STORE: Store;
let BM: any;
let rerankClient: OpenAI | null = null;

import { tokenize } from "./text_preprocess.js";

export async function loadStore(faissPath = "data/retrieval/index.faiss", metadataPath = "data/retrieval/metadata.json") {
    // Load FAISS index
    const faissBuffer = await fs.readFile(faissPath);
    const faissIndex = IndexFlatIP.fromBuffer(faissBuffer);

    // Load metadata
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));

    STORE = {
        chunks: metadata.chunks,
        faissIndex,
        bm25: metadata.bm25,
        dimension: metadata.dimension
    };

    // Initialize BM25
    BM = winkBM25();
    BM.defineConfig({ fldWeights: { text: 1 }, ovFldNames: ["text"] });
    BM.importJSON(metadata.bm25);
    BM.definePrepTasks([(t: any) => tokenize(t)]);

    console.log(`Loaded FAISS index with ${STORE.chunks.length} chunks, ${STORE.dimension}D embeddings`);
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
    const bmHits: [string, number][] = BM.search(query, bmN);
    const bmMap = new Map<string, number>(bmHits);

    // ANN via FAISS
    const qvec = await embedOne(query);
    if (qvec.length !== STORE.dimension) {
        throw new Error(
            `Embedding dimension mismatch: query=${qvec.length}, index=${STORE.dimension}. ` +
            `Ensure EMBED_MODEL during runtime matches the one used for indexing.`
        );
    }

    // FAISS search - returns SearchResult with distances and labels
    const searchResult = STORE.faissIndex.search(qvec, annN);
    const distances = Array.from(searchResult.distances);
    const indices = Array.from(searchResult.labels);

    // Convert FAISS results to similarity scores
    // IndexFlatIP returns inner products (dot products) which equal cosine similarity for normalized vectors
    const annResults = [];
    for (let i = 0; i < indices.length; i++) {
        const idx = indices[i] as number;
        const similarity = distances[i] as number;

        if (idx >= 0 && idx < STORE.chunks.length) {
            annResults.push({
                id: STORE.chunks[idx].id,
                score: similarity
            });
        }
    }

    const annMap = new Map<string, number>();
    for (const result of annResults) {
        annMap.set(result.id, result.score);
    }

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

    for (const r of combined) {
        const bm = norm(r.bm25, bmVals);
        const ann = norm(r.ann, annVals);
        r.score = 0.6 * bm + 0.4 * ann;
    }

    return combined.sort((a, b) => b.score! - a.score!);
}

// BM25-only retrieval (no embeddings required)
export function searchBM25(query: string, n = 200): Retrieved[] {
    const bmHits: [string, number][] = BM.search(query, n);
    const results: Retrieved[] = [];
    for (const [id, score] of bmHits) {
        const chunkIndex = STORE.chunks.findIndex((c) => c.id === id);
        if (chunkIndex >= 0) {
            results.push({
                chunk: STORE.chunks[chunkIndex],
                bm25: score,
                ann: 0,
                score
            });
        }
    }
    return results;
}

function getRerankClient() {
    if (!rerankClient) {
        const baseURL = process.env.LM_BASE_URL;
        const apiKey = process.env.LM_API_KEY;
        
        if (!baseURL) {
            console.warn("LM_BASE_URL not configured - reranking disabled");
            return null;
        }
        
        try {
            rerankClient = new OpenAI({
                baseURL,
                apiKey
            });
            
        } catch (error) {
            console.warn(`Failed to configure rerank client: ${error.message}`);
            return null;
        }
    }
    return rerankClient;
}

async function getRerankEmbedding(text: string): Promise<number[] | null> {
    const client = getRerankClient();
    if (!client) return null;
    
    try {
        const response = await client.embeddings.create({
            model: process.env.RERANK_MODEL,
            input: text.slice(0, 400) // Limit text length for reranking
        });
        return response.data[0].embedding;
    } catch (error) {
        console.warn("Rerank embedding failed:", error.message);
        return null;
    }
}

export async function rerankCrossEncoder(
    query: string,
    cands: Retrieved[],
    k = 50
): Promise<Retrieved[]> {
    const top = cands.slice(0, Math.max(k * 3, 30));

    const queryEmbedding = await getRerankEmbedding(query);
    if (!queryEmbedding) {
        return cands.slice(0, k);
    }
    
    // Score each candidate with semantic similarity
    const scoredCands = await Promise.all(
        top.map(async (cand) => {
            const passageEmbedding = await getRerankEmbedding(cand.chunk.text);
            if (!passageEmbedding) {
                return { ...cand, rerankScore: 0 };
            }
            
            const semanticScore = cosineSimilarity(queryEmbedding, passageEmbedding);
            return { ...cand, rerankScore: semanticScore };
        })
    );
    
    const reranked = scoredCands.sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));
    return reranked.slice(0, k);
}


