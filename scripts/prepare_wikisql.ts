import fs from "fs/promises";
import path from "path";
import https from "https";
import { createWriteStream } from "fs";
import { promisify } from "util";
import { execFile } from "child_process";
import { URL as NodeURL } from "node:url";

const ARCH = "datasets/wikisql-data.tar.bz2";
const URL_ARCH = "https://raw.githubusercontent.com/salesforce/WikiSQL/master/data.tar.bz2";
const URL_DEV_JSONL = "https://raw.githubusercontent.com/salesforce/WikiSQL/master/data/dev.jsonl";
const URL_TABLES_JSONL = "https://raw.githubusercontent.com/salesforce/WikiSQL/master/data/dev.tables.jsonl";
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
    let exists = false;
    try {
        const st = await fs.stat(toPath);
        if (st.size > 1024) return;
        exists = true;
    } catch {}
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    if (exists) {
        try { await fs.unlink(toPath); } catch {}
    }
    await new Promise<void>((resolve, reject) => {
        const file = createWriteStream(toPath);
        const get = (u: string, tries = 5) => {
            https
                .get(u, (res) => {
                    const code = res.statusCode || 0;
                    const loc = res.headers.location || "";
                    if (code >= 300 && code < 400 && loc && tries > 0) {
                        res.resume();
                        const next = loc.startsWith("http") ? loc : new NodeURL(loc, u).toString();
                        get(next, tries - 1);
                        return;
                    }
                    if (code >= 400) {
                        reject(new Error(`HTTP ${code}`));
                        return;
                    }
                    res.pipe(file);
                    file.on("finish", () => file.close(() => resolve()));
                })
                .on("error", reject);
        };
        get(url);
    });
}

async function extractTarBz2(archivePath: string, outDir: string) {
    await fs.mkdir(outDir, { recursive: true });
    const execFileAsync = promisify(execFile);
    // sstem tar for bzip2 archives
    await execFileAsync("tar", ["-xjf", archivePath, "-C", outDir]);
}

const readJSONL = async (p: string) =>
    (await fs.readFile(p, "utf8"))
        .trim()
        .split(/\n+/)
        .map((l) => JSON.parse(l));

const MAX_EX = 60;

async function run() {
    await fs.mkdir(OUT_TABLES, { recursive: true });
    await fetchIfMissing(URL_ARCH, ARCH);
    let hasDev = false;
    try {
        await fs.access(DEV);
        hasDev = true;
    } catch {}
    if (!hasDev) {
        try {
            await extractTarBz2(ARCH, "datasets");
            await fs.access(DEV);
            hasDev = true;
        } catch {}
    }
    if (!hasDev) {
        await fetchIfMissing(URL_DEV_JSONL, DEV);
        await fetchIfMissing(URL_TABLES_JSONL, TABLES);
        await fs.access(DEV); // will throw if still missing
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
