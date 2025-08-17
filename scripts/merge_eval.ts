import fs from "fs/promises";

const files = [
    "src/eval/squad_eval.json",
    "src/eval/hotpot_eval.json",
    "src/eval/wikisql_eval.json",
];

async function run() {
    const all: any[] = [];
    for (const f of files) {
        try {
            const arr = JSON.parse(await fs.readFile(f, "utf8"));
            if (Array.isArray(arr)) all.push(...arr);
        } catch {
            // no file
        }
    }
    await fs.writeFile("src/eval/eval.json", JSON.stringify(all, null, 2));
    console.log(`Merged ${all.length} eval cases → src/eval/eval.json`);
}
run().catch((e) => {
    console.error(e);
    process.exit(1);
});
