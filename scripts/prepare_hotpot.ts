import fs from "fs/promises";
import path from "path";
import https from "https";

const RAW = "datasets/hotpot-dev-distractor.json";
const OUT_DOCS = "data/docs";
const OUT_EVAL = "src/eval/hotpot_eval.json";

type QA = {
    question: string;
    context: [string, string[]][];
    supporting_facts: [string, number][];
};

const slug = (s: string) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");

const MAX_Q = 120;

async function run() {
    await fs.mkdir(OUT_DOCS, { recursive: true });
    try {
        await fs.access(RAW);
    } catch {
        await fetchFromHuggingFace(RAW, MAX_Q);
    }
    const raw: QA[] = JSON.parse(await fs.readFile(RAW, "utf8"));

    const byTitle: Record<string, string[]> = {};
    const evalCases: any[] = [];
    let used = 0;

    for (const ex of raw) {
        for (const [title, sents] of ex.context) {
            if (!byTitle[title]) byTitle[title] = [];
            byTitle[title].push(sents.join(" "));
        }
        const goldTitles = Array.from(
            new Set(ex.supporting_facts.map(([t]) => t))
        );
        evalCases.push({
            q: ex.question,
            gold_doc_ids: goldTitles.map((t) => `${slug(t)}.txt`),
        });
        used++;
        if (used >= MAX_Q) break;
    }

    for (const [title, parts] of Object.entries(byTitle)) {
        const fname = path.join(OUT_DOCS, `${slug(title)}.txt`);
        const content = Array.from(new Set(parts)).join("\n\n");
        await fs.writeFile(fname, content);
    }

    await fs.writeFile(OUT_EVAL, JSON.stringify(evalCases, null, 2));
    console.log(`Hotpot: wrote ${evalCases.length} eval cases → ${OUT_EVAL}`);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});

async function fetchFromHuggingFace(toPath: string, maxRows: number) {
    const pageSize = 100;
    const rows: QA[] = [];
    let offset = 0;

    const getJSON = (url: string): Promise<any> =>
        new Promise((resolve, reject) => {
            https
                .get(url, (res) => {
                    if (res.statusCode && res.statusCode >= 400) {
                        res.resume();
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    const chunks: Buffer[] = [];
                    res.on("data", (c) =>
                        chunks.push(typeof c === "string" ? Buffer.from(c) : c)
                    );
                    res.on("end", () => {
                        try {
                            const body = Buffer.concat(chunks).toString("utf8");
                            resolve(JSON.parse(body));
                        } catch (err) {
                            reject(err);
                        }
                    });
                })
                .on("error", reject);
        });

    while (rows.length < maxRows) {
        const length = Math.min(pageSize, maxRows - rows.length);
        const url = `https://datasets-server.huggingface.co/rows?dataset=hotpotqa/hotpot_qa&config=distractor&split=validation&offset=${offset}&length=${length}`;
        const data = await getJSON(url);
        const batch = Array.isArray(data?.rows) ? data.rows : [];
        if (batch.length === 0) break;

        for (const item of batch) {
            const r = item.row;
            if (!r) continue;
            const titles: string[] = r.context?.title || [];
            const sentences: string[][] = r.context?.sentences || [];
            const context: [string, string[]][] = titles.map((t, i) => [
                t,
                sentences[i] || [],
            ]);
            const sfTitles: string[] = r.supporting_facts?.title || [];
            const sfIds: number[] = r.supporting_facts?.sent_id || [];
            const supporting_facts: [string, number][] = sfTitles.map(
                (t, i) => [t, sfIds[i] ?? 0]
            );

            rows.push({
                question: r.question,
                context,
                supporting_facts,
            });
            if (rows.length >= maxRows) break;
        }
        offset += batch.length;
    }

    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.writeFile(toPath, JSON.stringify(rows, null, 2));
}
