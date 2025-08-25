import fs from "fs/promises";
import path from "path";
import winkBM25 from "wink-bm25-text-search";
import { tokenize } from "./text_preprocess.js";
import pkg from "faiss-node";
const { IndexFlatIP } = pkg;
import { embedBatch } from "../embed.js";
import { smartChunk, type Chunk } from "./chunk.js";

const DATA_DIR = "data/docs";
const FAISS_INDEX_PATH = "data/retrieval/index.faiss";
const METADATA_PATH = "data/retrieval/metadata.json";

type Metadata = {
    chunks: Chunk[];
    bm25: any;
    dimension: number;
}

async function loadText(filePath: string): Promise<{ docId: string; text: string }> {
    const ext = path.extname(filePath).toLowerCase();
    const docId = path.basename(filePath);
    if (ext === ".pdf") {
      // @ts-ignore
      const { default: pdf } = await import("pdf-parse");
      const data = await pdf(await fs.readFile(filePath));
      return { docId, text: data.text };
    }
    return { docId, text: (await fs.readFile(filePath, "utf8")).toString() };
  }

  
async function main() {
    const files = (await fs.readdir(DATA_DIR)).map((f) => path.join(DATA_DIR, f));
    const allChunks: Chunk[] = [];
    for (const f of files) {
        const { docId, text } = await loadText(f);
        const ch = smartChunk(text, docId);
        allChunks.push(...ch);
    }

    // BM25 setup
    const bm25 = winkBM25();
    bm25.defineConfig({ fldWeights: { text: 1 }, ovFldNames: ["text"] });
    bm25.definePrepTasks([(t: any) => tokenize(t)]);
    allChunks.forEach((c) => bm25.addDoc({ text: c.text }, c.id));
    bm25.consolidate();

    // Generate embeddings
    const texts = allChunks.map((c) => c.text);
    const embeddings = await embedBatch(texts, 64);
    if (!embeddings.length) {
        throw new Error("No embeddings generated. Check EMBED_MODEL and LM_BASE_URL/LM_API_KEY.");
    }
    const dimension = embeddings[0]!.length;
    // Validate all vectors have same dimension
    for (let i = 0; i < embeddings.length; i++) {
        if (embeddings[i]!.length !== dimension) {
            throw new Error(`Embedding dimension mismatch at index ${i}: got ${embeddings[i]!.length}, expected ${dimension}`);
        }
    }

    // Create FAISS index
    const index = new IndexFlatIP(dimension);

    // Convert embeddings to Float32Array for FAISS
    const embeddingArray = new Float32Array(embeddings.length * dimension);
    for (let i = 0; i < embeddings.length; i++) {
        for (let j = 0; j < dimension; j++) {
            embeddingArray[i * dimension + j] = embeddings[i][j];
        }
    }

    // Add vectors to FAISS index
    // FAISS expects a regular array, not Float32Array
    const embeddingArrayRegular = Array.from(embeddingArray);
    index.add(embeddingArrayRegular);

    // Save FAISS index
    await fs.mkdir(path.dirname(FAISS_INDEX_PATH), { recursive: true });
    await fs.writeFile(FAISS_INDEX_PATH, Buffer.from(index.toBuffer()));

    // Save metadata (chunks, BM25, dimension)
    const metadata: Metadata = {
        chunks: allChunks,
        bm25: bm25.exportJSON(),
        dimension
    };
    await fs.mkdir(path.dirname(METADATA_PATH), { recursive: true });
    await fs.writeFile(METADATA_PATH, JSON.stringify(metadata));

    console.log(`Indexed ${allChunks.length} chunks with ${dimension}D embeddings`);
    console.log(`FAISS index saved: ${FAISS_INDEX_PATH}`);
    console.log(`Metadata saved: ${METADATA_PATH}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});