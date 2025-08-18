import fs from "fs/promises";
import path from "path";
import pdf from "pdf-parse";
import winkBM25 from "wink-bm25-text-search";
import { embedBatch } from "../embed.js";
import { simpleChunk, type Chunk } from "./chunk.js";

const DATA_DIR = "data/docs";
const OUT = "src/retrieval/store.json";

type Store = {
    chunks: Chunk[];
    embeddings: number[][];
    bm25: any;
}

function tokenize(text: string) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
}

async function loadText(filePath: string): Promise<{ docId: string; text: string }> {
    const ext = path.extname(filePath).toLowerCase();
    const docId = path.basename(filePath);
    if (ext === ".pdf") {
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
        const ch = simpleChunk(text, docId, 900);
        allChunks.push(...ch);
    }

    const bm25 = winkBM25();
    bm25.defineConfig({ fldWights: { text: 1}});
    bm25.definePrepTasks([(t: any) => tokenize(t)]);
    allChunks.forEach((c) => bm25.addDoc({ text: c.text, id: c.id }));

    bm25.consolidate();

    const texts = allChunks.map((c) => c.text);
    const embeddings = await embedBatch(texts, 64);

    const store: Store = {
        chunks: allChunks,
        embeddings,
        bm25: bm25.export()
    };
    await fs.writeFile(OUT, JSON.stringify(store));
    console.log(`Indexed ${allChunks.length} chunks: ${OUT}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});