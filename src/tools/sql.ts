import fs from "fs/promises";
import path from "path";
import duckdb from "duckdb";
import { openai, MODEL } from "../lm.js";

export interface TableInfo {
    alias: string;
    domain: string;
    columns: string[];
    sampleData: any;
    description: string;
}

// Persist to disk so tables are available across processes
const DB_PATH = path.resolve("data", "duck.db");
const db = new duckdb.Database(DB_PATH);

export async function initDuckDB(csvDir = "data/tables") {
    const con = db.connect();
    const runAsync = (sql: string) => new Promise<void>((resolve, reject) => {
        con.run(sql, (err: any) => (err ? reject(err) : resolve()));
    });
    await runAsync(`CREATE TABLE IF NOT EXISTS __init(x INT);`);

    // Ensure data dir exists
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });

    // auto-load all CSVs in data/tables as tables named by filename (sans extension)
    try {
        const files = await fs.readdir(csvDir);
        for (const f of files) {
            if (!f.toLowerCase().endsWith(".csv")) continue;
            const base = path.basename(f, path.extname(f));
            const alias = base.replace(/[^a-zA-Z0-9_]/g, "_");
            const full = path.resolve(csvDir, f).replace(/'/g, "''");
            const quoted = '"' + base.replace(/"/g, '""') + '"';
            
            try {
                await runAsync(`CREATE OR REPLACE TABLE ${quoted} AS SELECT * FROM read_csv_auto('${full}', delim=',', header=true, ignore_errors=true);`);
            } catch (e: any) {
                console.warn(`Failed to load CSV ${f}:`, e.message);
                continue;
            }
            
            await runAsync(`CREATE OR REPLACE VIEW t_${alias} AS SELECT * FROM ${quoted};`);
        }
    } catch (e: any) {
        console.warn("DuckDB init error:", e?.message || e);
    }

    await con.close();
}

export async function listTableAliases(csvDir = "data/tables"): Promise<string[]> {
    try {
        const files = await fs.readdir(csvDir);
        const aliases: string[] = [];
        for (const f of files) {
            if (!f.toLowerCase().endsWith(".csv")) continue;
            const base = path.basename(f, path.extname(f));
            const alias = "t_" + base.replace(/[^a-zA-Z0-9_]/g, "_");
            aliases.push(alias);
        }
        return aliases;
    } catch {
        return [];
    }
}

export async function duckdb_sql(args: { sql: string }) {
    const con = db.connect();
    try {
        const rows = await new Promise<any[]>((resolve, reject) => {
            con.all(args.sql, (err: any, res: any[]) => {
                if (err) reject(err);
                else resolve(res);
            });
        });
        const normalized = rows.map((r) =>
            Object.fromEntries(
                Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
            )
        );
        return JSON.stringify(normalized).slice(0, 8000); // limit output size
    } catch (e: any) {
        return `ERROR: ${e.message}`;
    } finally {
        await con.close();
    }
}

// Load precomputed table metadata from build time indexing
export async function loadTableIndex(): Promise<TableInfo[]> {
    try {
        const content = await fs.readFile("data/tools/table_index.json", 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`Failed to load table index: ${error.message}`);
        return [];
    }
}

export async function selectRelevantTables(question: string, tables: TableInfo[]): Promise<TableInfo[]> {
    if (tables.length === 0) return [];
    
    const tablesInfo = tables.map(table => ({
        alias: table.alias,
        domain: table.domain,
        description: table.description.substring(0, 200) + (table.description.length > 200 ? '...' : ''), // Truncate long descriptions
        columns: table.columns.slice(0, 5).join(', ') + (table.columns.length > 5 ? '...' : '') // Limit columns shown
    }));

    const prompt = `Given a user question, select the most relevant database tables that could answer it.

    User Question: "${question}"

    Available Tables:
    ${tablesInfo.map((table, idx) => 
        `${idx + 1}. ${table.alias} (${table.domain}): ${table.description}
    Key columns: ${table.columns}`
    ).join('\n')}

    Instructions:
    1. Analyze the user's question to understand what data they're looking for
    2. Consider which tables contain relevant information to answer the question
    3. Select up to 3 most relevant tables, ranked by relevance
    4. If no tables seem relevant, return an empty array

    Respond with a JSON array of table aliases in order of relevance:
    ["most_relevant_alias", "second_most_relevant", "third_most_relevant"]

    If no tables are relevant, respond with: []`;

    try {
        const response = await openai.chat.completions.create({
            model: MODEL,
            messages: [
                { role: "system", content: "You are a database analyst. Given a question and available tables, select the most relevant tables that could answer the question. Always respond with a valid JSON array." },
                { role: "user", content: prompt }
            ],
            temperature: 0.1
        });

        const content = response.choices[0]?.message?.content?.trim();
        if (!content) return [];
        
        // Clean up markdown formatting if present
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const selectedAliases = JSON.parse(cleanContent);
        if (!Array.isArray(selectedAliases)) return [];
        
        // Return tables in the order of relevance determined by LLM
        return selectedAliases
            .map(alias => tables.find(t => t.alias === alias))
            .filter(table => table !== undefined) as TableInfo[];
            
    } catch (error) {
        console.warn(`Failed to select tables via LLM: ${error.message} - model may not have appropriate context.`);
        return tables.slice(0, 3); // Fallback to first 3 tables
    }
}

export async function buildGenericQuery(question: string, table: TableInfo): Promise<string> {
    const prompt = `Generate a SQL query to answer the user's question using the provided table.

    User Question: "${question}"

    Table Information:
    - Table Name: ${table.alias}
    - Domain: ${table.domain}
    - Description: ${table.description.substring(0, 300)}
    - Columns: ${table.columns.join(', ')}

    Requirements:
    1. Generate a single SQL query that best answers the user's question
    2. Use only the columns that exist in this table
    3. Make the query specific to what the user is asking
    4. Use proper SQL syntax (quote strings with single quotes, proper column names)
    5. If the question asks for counts, use COUNT(*)
    6. If the question asks for specific records, use appropriate WHERE clauses
    7. Limit results appropriately (use LIMIT for exploration queries)

    Return only the SQL query, no explanation:`;

    try {
        const response = await openai.chat.completions.create({
            model: MODEL,
            messages: [
                { role: "system", content: "You are a SQL expert. Generate SQL queries based on user questions and table schemas. Return only the SQL query." },
                { role: "user", content: prompt }
            ],
            temperature: 0.1
        });

        const content = response.choices[0]?.message?.content?.trim();
        if (!content) throw new Error("Empty response");
        
        // Clean up
        const cleanQuery = content.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();
        return cleanQuery;
        
    } catch (error) {
        console.warn(`Failed to generate query via LLM: ${error.message}, using fallback`);
        
        // Simple fallback
        if (question.toLowerCase().includes('how many') || question.toLowerCase().includes('count')) {
            return `SELECT COUNT(*) FROM ${table.alias}`;
        }
        return `SELECT * FROM ${table.alias} LIMIT 5`;
    }
}
