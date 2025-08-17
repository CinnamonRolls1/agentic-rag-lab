export type Chunk = {
    id: string;
    docId: string;
    text: string;
    page?: number;
};
  
  export function simpleChunk(text: string, docId: string, chars = 800): Chunk[] {
    const chunks: Chunk[] = [];
    for (let i = 0, j = 0; i < text.length; i += chars, j++) {
        const slice = text.slice(i, Math.min(i + chars, text.length));
        if (slice.trim().length === 0) continue;
        chunks.push({ id: `${docId}#${j}`, docId, text: slice });
    }
    return chunks;
}

// TODO: semantic chunking later
  