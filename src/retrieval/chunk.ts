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

// Lightweight sentence-based chunking with overlap
export function sentenceChunk(
    raw: string,
    docId: string,
    targetChars = 900,
    overlapSentences = 1
): Chunk[] {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return [];
    // naive sentence split: keep terminator
    const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/g);
    const chunks: Chunk[] = [];
    let buf: string[] = [];
    let bufLen = 0;
    let idx = 0;
    const flush = () => {
        const joined = buf.join(' ').trim();
        if (joined.length > 0) {
            chunks.push({ id: `${docId}#${idx++}`, docId, text: joined });
        }
    };
    for (let i = 0; i < parts.length; i++) {
        const s = parts[i].trim();
        if (!s) continue;
        if (bufLen + s.length + 1 > targetChars && buf.length > 0) {
            flush();
            // start new buffer with overlap
            const overlap = Math.max(0, Math.min(overlapSentences, buf.length));
            buf = buf.slice(buf.length - overlap);
            bufLen = buf.join(' ').length;
        }
        buf.push(s);
        bufLen += (bufLen ? 1 : 0) + s.length;
    }
    if (buf.length) flush();
    return chunks;
}

export function smartChunk(text: string, docId: string): Chunk[] {
    // Prefer sentence-based with small overlap; fallback to simple
    const sc = sentenceChunk(text, docId, 900, 1);
    if (sc.length > 0) return sc;
    return simpleChunk(text, docId, 900);
}
