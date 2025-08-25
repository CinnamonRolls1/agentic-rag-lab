import fs from "fs/promises";
import path from "path";
import { initDuckDB, duckdb_sql, listTableAliases } from "./sql.js";
import { openai, MODEL } from "../lm.js";

export interface TableInfo {
    alias: string;
    domain: string;
    columns: string[];
    sampleData: any;
    description: string;
}

const TABLE_INDEX_PATH = "data/tools/table_index.json";

async function classifyTableDomain(columns: string[], sampleData: any): Promise<{ domain: string; description: string }> {
    const prompt = `Analyze this database table and classify its domain and purpose.

Table Columns: ${columns.join(', ')}
Sample Row: ${JSON.stringify(sampleData, null, 2)}

Tasks:
1. Determine the primary domain/category this table represents
2. Write a clear, specific description of what data this table contains
3. Choose or create the most appropriate domain name (be specific, not generic)

Guidelines:
- Focus on the actual data content, not just column names
- Create domain names that accurately reflect the data (e.g., "Professional Basketball", "Formula 1 Racing", "Political Leaders")
- Avoid overly broad categories like "Sports" - be specific about what type of sports data
- The description should be detailed enough that someone could understand the table's purpose

Respond with JSON in this exact format:
{
  "domain": "Specific Domain Name",
  "description": "Detailed description of what this table contains and its purpose"
}`;

    try {
        const response = await openai.chat.completions.create({
            model: MODEL,
            messages: [
                { role: "system", content: "You are a database schema analyst. Analyze the provided table structure and sample data to determine its domain and purpose. Always respond with valid JSON." },
                { role: "user", content: prompt }
            ],
            temperature: 0.1
        });

        const content = response.choices[0]?.message?.content?.trim();
        if (!content) throw new Error("Empty response");
        
        // Clean up markdown formatting if present
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(cleanContent);
    } catch (error) {
        console.warn(`Failed to classify table domain via LLM: ${error.message}, using fallback`);
        return { domain: 'Unknown', description: 'Unable to classify table structure' };
    }
}

export async function buildTableIndex(): Promise<TableInfo[]> {
    console.log("Building table index...");
    
    // Initialize DuckDB and discover tables
    await initDuckDB();
    const aliases = await listTableAliases();
    const tables: TableInfo[] = [];
    
    for (const alias of aliases) {
        try {
            console.log(`Processing table: ${alias}`);
            
            // Get sample data and schema
            const sample = await duckdb_sql({ sql: `SELECT * FROM ${alias} LIMIT 1` });
            const parsed = JSON.parse(sample);
            
            if (parsed.length > 0) {
                const columns = Object.keys(parsed[0]);
                const sampleData = parsed[0];
                
                // Use LLM to classify domain
                const { domain, description } = await classifyTableDomain(columns, sampleData);
                
                const tableInfo: TableInfo = {
                    alias,
                    domain,
                    columns,
                    sampleData,
                    description
                };
                
                tables.push(tableInfo);
                console.log(`✓ Classified ${alias} as ${domain}: ${description}`);
            }
        } catch (error) {
            console.warn(`Failed to process table ${alias}: ${error.message}`);
        }
    }
    
    return tables;
}

export async function saveTableIndex(tables: TableInfo[]): Promise<void> {
    await fs.mkdir(path.dirname(TABLE_INDEX_PATH), { recursive: true });
    await fs.writeFile(TABLE_INDEX_PATH, JSON.stringify(tables, null, 2));
    console.log(`Saved table index with ${tables.length} tables to ${TABLE_INDEX_PATH}`);
}

export async function loadTableIndex(): Promise<TableInfo[]> {
    try {
        const content = await fs.readFile(TABLE_INDEX_PATH, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`Failed to load table index: ${error.message}`);
        return [];
    }
}

// Main execution when run directly
async function main() {
    try {
        const tables = await buildTableIndex();
        await saveTableIndex(tables);
        console.log(`Successfully indexed ${tables.length} tables`);
    } catch (error) {
        console.error(`Table indexing failed: ${error.message}`);
        process.exit(1);
    }
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
