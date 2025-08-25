// @ts-ignore
import { evaluate } from "mathjs";

export function math_eval(args: { expr: string }) {
    try {
        return String(evaluate(args.expr));
    } catch (e: any) {
        return `ERROR: ${e.message}`;
    }
}
