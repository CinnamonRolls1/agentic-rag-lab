import natural from "natural";
import { english as stopwords } from "stopwords";

const STOP_WORDS = new Set(stopwords);
const tokenizer = new natural.WordTokenizer();

export function tokenize(text: string): string[] {
    const lower = text.toLowerCase();
    const rawTokens = tokenizer.tokenize(lower);
    const cleaned = rawTokens
        .map((t) => t.replace(/[^a-z0-9]/g, ""))
        .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    const stemmed = cleaned.map((t) => natural.PorterStemmer.stem(t));
    return stemmed;
}


