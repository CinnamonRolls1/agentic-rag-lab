import fs from "fs/promises";
import path from "path";
import pdf from "pdf-parse";
import winkBM25 from "wink-bm25-text-search";
import { embedBatch } from "../embed.js";
import { simpleChunk, type Chunk } from "./chunk.js";

