import fs from "fs/promises";
import path from "path";
import duckdb from "duckdb";

const db = new duckdb.Database(":memory:");
let initialized = false;

export async function initDuckDB(csvDir = "data/tables") {
    if (initialized) return;
    const con = db.connect();
    await con.run(`CREATE TABLE IF NOT EXISTS __init(x INT);`);

    // auto-load all CSVs in data/tables as tables named by filename (sans extension)
    try {
        const files = await fs.readdir(csvDir);
        for (const f of files) {
            if (!f.toLowerCase().endsWith(".csv")) continue;
            const table = path
                .basename(f, path.extname(f))
                .replace(/[^a-zA-Z0-9_]/g, "_");
            const full = path.join(csvDir, f);
            await con.run(
                `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_csv_auto('${full}', HEADER TRUE);`
            );
        }
    } catch {}

    await con.close();
    initialized = true;
}

export async function duckdb_sql(args: { sql: string }) {
    const con = db.connect();
    try {
        const res = await con.all(args.sql);
        await con.close();
        return JSON.stringify(res).slice(0, 8000); // limit output size
    } catch (e: any) {
        await con.close();
        return `ERROR: ${e.message}`;
    }
}
