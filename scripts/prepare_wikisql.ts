import fs from "fs/promises";
import path from "path";
import https from "https";
import { createGunzip } from "zlib";
import { createWriteStream, createReadStream } from "fs";
import { pipeline as nodePipeline } from "stream";
import { promisify } from "util";
import * as tar from "tar";

const pipeline = promisify(nodePipeline as any);

const ARCH = "datasets/wikisql-data.tar.bz2";
const URL = "https://github.com/salesforce/WikiSQL/raw/master/data.tar.bz2";
const ROOT = "datasets/data";
const DEV = `${ROOT}/dev.jsonl`;
const TABLES = `${ROOT}/dev.tables.jsonl`;

const OUT_TABLES = "data/tables";
const OUT_EVAL = "src/eval/wikisql_eval.json";

type Table = { id: string; header: string[]; rows: any[][] };
type Ex = { question: string; table_id: string; sql: any };

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
        await new Promise<void>((resolve, reject) => {
            const file = createWriteStream(toPath);
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

async function extractTarBz2(archivePath: string, outDir: string) {
    await fs.mkdir(outDir, { recursive: true });
    // tar module can handle .bz2 transparently with strip option
    await tar.x({ file: archivePath, cwd: "datasets" }); // extracts into datasets/data/*
}

const readJSONL = async (p: string) =>
    (await fs.readFile(p, "utf8"))
        .trim()
        .split(/\n+/)
        .map((l) => JSON.parse(l));

const MAX_EX = 60;

async function run() {
    await fs.mkdir(OUT_TABLES, { recursive: true });
    await fetchIfMissing(URL, ARCH);
    // Extract if datasets/data not present
    try {
        await fs.access(DEV);
    } catch {
        await extractTarBz2(ARCH, "datasets");
    }

    const tables: Table[] = await readJSONL(TABLES);
    const byId = new Map(tables.map((t) => [t.id, t]));
    const dev: Ex[] = await readJSONL(DEV);

    const evalCases: any[] = [];
    const seenTables = new Set<string>();

    for (const ex of dev.slice(0, MAX_EX)) {
        const t = byId.get(ex.table_id)!;
        const fname = slug(ex.table_id) + ".csv";
        if (!seenTables.has(ex.table_id)) {
            const csv = [t.header.join(",")]
                .concat(
                    t.rows.map((r) =>
                        r.map((x) => String(x).replaceAll('"', '""')).join(",")
                    )
                )
                .join("\n");
            await fs.writeFile(path.join(OUT_TABLES, fname), csv);
            seenTables.add(ex.table_id);
        }
        evalCases.push({
            q: ex.question,
            gold_table: fname,
            gold_sql: ex.sql,
        });
    }

    await fs.writeFile(OUT_EVAL, JSON.stringify(evalCases, null, 2));
    console.log(
        `WikiSQL: ${evalCases.length} eval cases; ${seenTables.size} CSV tables → ${OUT_TABLES}`
    );
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
