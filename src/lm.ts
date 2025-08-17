import OpenAI from "openai";
import "dotenv/config";

export const openai = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: "not-needed"});

export const model = process.env.LMMODEL!;

export async function classifyPlan(question: string) {
    const sys = `You are a planner. Output exactly one label:
    - single
    - multi
    - needs_calc
    - not_answerable
    If multiple apply, choose the most specific one. Only output the label.`;
}