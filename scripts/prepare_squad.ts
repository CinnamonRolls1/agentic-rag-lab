import fs from "fs/promises";
import path from "path";
import https from "https";

const RAW = "datasets/squad-v2-dev.json";
const URL = "https://rajpurkar.github.io/SQuAD-explorer/dataset/dev-v2.0.json";
const OUT_DOCS = "data/docs";
const OUT_EVAL = "src/eval/squad_eval.json";

type QA = { question: string; is_impossible?: boolean };
type Para = { context: string; qas: QA[] };
type Article = { title: string; paragraphs: Para[] };
type Squad = { data: Article[] };

const slug = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");

async function fetchIfMissing(url: string, toPath: string) {
    try {
        await fs.access(toPath);
        return;
    } catch {
        await fs.mkdir(path.dirname(toPath), { recursive: true });
        const handle = await fs.open(toPath, "w");
        const file = handle.createWriteStream();
        await new Promise<void>((resolve, reject) => {
            https
                .get(url, (res) => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    res.pipe(file);
                    file.on("finish", () => file.close(() => resolve()));
                })
                .on("error", reject);
        });
    }
}

const MAX_Q = 200; // subset for demo

async function run() {
    await fs.mkdir(OUT_DOCS, { recursive: true });
    await fetchIfMissing(URL, RAW);

    const raw: Squad = JSON.parse(await fs.readFile(RAW, "utf8"));
    const evalCases: any[] = [];
    let used = 0;

    for (const a of raw.data) {
        const fname = `${slug(a.title)}.txt`;
        const body = a.paragraphs.map((p) => p.context).join("\n\n");
        await fs.writeFile(path.join(OUT_DOCS, fname), body);

        for (const p of a.paragraphs) {
            for (const qa of p.qas) {
                if (used < MAX_Q) {
                    evalCases.push({
                        q: qa.question,
                        gold_doc_ids: [fname],
                        unanswerable: !!qa.is_impossible,
                    });
                    used++;
                }
            }
        }
    }

    await fs.writeFile(OUT_EVAL, JSON.stringify(evalCases, null, 2));
    console.log(`SQuAD: wrote ${used} eval cases → ${OUT_EVAL}`);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
