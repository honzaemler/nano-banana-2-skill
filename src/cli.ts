#!/usr/bin/env -S bun --no-env-file
/**
 * Nano Banana 2 - AI Image Generation CLI
 * Default: Gemini 3.1 Flash Image Preview (Nano Banana 2)
 * Also supports: Gemini 3 Pro Image Preview (Nano Banana Pro) and any model ID
 *
 * Usage:
 *   nano-banana "your prompt here"
 *   nano-banana "your prompt" --output myimage
 *   nano-banana "your prompt" --ref image.png        # Use reference image
 *   nano-banana "your prompt" -r img1.png -r img2.png # Multiple references
 *   nano-banana "your prompt" --model pro             # Use Pro model
 *   nano-banana "your prompt" -a 16:9                 # Set aspect ratio
 */

import { GoogleGenAI } from "@google/genai";
import { writeFile, mkdir, readFile, rename } from "fs/promises";
import { join, extname, basename, dirname, resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Environment / API key resolution
// Priority: --api-key flag > GEMINI_API_KEY env var > .env in cwd > .env next
// to this script > ~/.nano-banana/.env
// ---------------------------------------------------------------------------

// Only these keys are read from .env files. Anything else (e.g. a foreign
// repo's secrets) is ignored so it never lands in process.env or child
// processes. Bun's own .env autoload is disabled via --no-env-file in the
// shebang for the same reason.
const ENV_WHITELIST = new Set(["GEMINI_API_KEY"]);

// Which .env file supplied GEMINI_API_KEY (undefined if none did).
let apiKeySource: string | undefined;

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [rawKey, ...valueParts] = trimmed.split("=");
      const key = rawKey.replace(/^export\s+/, "").trim();
      if (!ENV_WHITELIST.has(key)) continue;
      const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
      if (value && !process.env[key]) {
        process.env[key] = value;
        if (key === "GEMINI_API_KEY") apiKeySource = path;
      }
    }
  }
}

// Try multiple .env locations (first match wins per-key due to the guard above)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const cwdEnvPath = join(process.cwd(), ".env");
const repoEnvPath = join(__dirname, "..", ".env");

loadEnvFile(cwdEnvPath);
loadEnvFile(repoEnvPath);                           // repo root .env
loadEnvFile(join(homedir(), ".nano-banana", ".env"));

// A .env in the current directory wins over ~/.nano-banana, so running the
// CLI inside another project silently uses (and bills) that project's key.
const apiKeyFromForeignCwd =
  apiKeySource === cwdEnvPath && resolve(cwdEnvPath) !== resolve(repoEnvPath);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_ALIASES: Record<string, string> = {
  flash: "gemini-3.1-flash-image-preview",
  nb2: "gemini-3.1-flash-image-preview",
  pro: "gemini-3-pro-image-preview",
  "nb-pro": "gemini-3-pro-image-preview",
};

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";

const VALID_SIZES = ["512", "1K", "2K", "4K"] as const;
type ImageSize = (typeof VALID_SIZES)[number];

const VALID_ASPECTS = [
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "4:5", "5:4", "21:9", "1:4", "1:8", "4:1", "8:1",
] as const;

// Paid tier (standard) rates in USD per 1M tokens, per
// https://ai.google.dev/gemini-api/docs/pricing (checked 2026-09-30).
// textOutput also covers thinking tokens.
const COST_RATES: Record<string, { input: number; textOutput: number; imageOutput: number }> = {
  "gemini-3.1-flash-image-preview": { input: 0.5, textOutput: 3, imageOutput: 60 },
  "gemini-3-pro-image-preview": { input: 2.0, textOutput: 12, imageOutput: 120 },
};

// Grounding with Google Search: 5,000 free requests per month shared across
// all Gemini 3.x models, then $14 per 1,000. The CLI can't see the account's
// monthly usage, so every query is priced at the list rate (upper bound).
const SEARCH_QUERY_COST = 14 / 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Options {
  prompt: string;
  output: string;
  size: ImageSize;
  outputDir: string;
  referenceImages: string[];
  transparent: boolean;
  apiKey: string | undefined;
  model: string;
  aspectRatio: string | undefined;
}

interface CostEntry {
  timestamp: string;
  model: string;
  size: string;
  aspect: string | null;
  prompt_tokens: number;
  output_tokens: number;
  image_tokens?: number;
  text_tokens?: number;
  thoughts_tokens?: number;
  search_queries?: number;
  grounding_cost?: number;
  // null when the model has no known pricing
  estimated_cost: number | null;
  output_file: string;
}

interface TokenUsage {
  promptTokens: number;
  imageTokens: number;
  textTokens: number;
  thoughtsTokens: number;
}

interface CostBreakdown {
  tokenCost: number;
  groundingCost: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return mimeTypes[ext] || "image/png";
}

async function loadImageAsBase64(
  filePath: string
): Promise<{ data: string; mimeType: string }> {
  const absolutePath = filePath.startsWith("/")
    ? filePath
    : join(process.cwd(), filePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Image not found: ${absolutePath}`);
  }

  const buffer = await readFile(absolutePath);
  return {
    data: buffer.toString("base64"),
    mimeType: getMimeType(filePath),
  };
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} failed (exit ${code}): ${stderr}`));
    });
    proc.on("error", (err) => {
      reject(
        new Error(
          `Failed to run ${cmd}: ${err.message}. Is it installed?`
        )
      );
    });
  });
}

function runMagick(args: string[]): Promise<string> {
  return runCommand("magick", args);
}

function resolveModel(input: string): string {
  return MODEL_ALIASES[input.toLowerCase()] || input;
}

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

const COST_LOG_PATH = join(homedir(), ".nano-banana", "costs.json");

async function logCost(entry: CostEntry): Promise<void> {
  const dir = dirname(COST_LOG_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  let entries: CostEntry[] = [];
  if (existsSync(COST_LOG_PATH)) {
    const raw = await readFile(COST_LOG_PATH, "utf-8");
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      entries = parsed;
    } catch {
      // Keep the unreadable history instead of overwriting it
      const backupPath = `${COST_LOG_PATH}.corrupt-${Date.now()}`;
      await rename(COST_LOG_PATH, backupPath);
      console.error(
        `\x1b[33mWarning:\x1b[0m cost log was unreadable, moved to ${backupPath} and started a new one.`
      );
    }
  }

  entries.push(entry);
  // Write to a temp file first so an interrupted write can't corrupt the log
  const tmpPath = `${COST_LOG_PATH}.tmp`;
  await writeFile(tmpPath, JSON.stringify(entries, null, 2));
  await rename(tmpPath, COST_LOG_PATH);
}

function printCostSummary(): void {
  if (!existsSync(COST_LOG_PATH)) {
    console.log("\x1b[90mNo cost data found.\x1b[0m");
    return;
  }

  let entries: CostEntry[];
  try {
    entries = JSON.parse(readFileSync(COST_LOG_PATH, "utf-8"));
    if (!Array.isArray(entries)) throw new Error("not an array");
  } catch {
    console.log(`\x1b[31mError reading cost log:\x1b[0m ${COST_LOG_PATH} is not a valid JSON array.`);
    return;
  }

  if (entries.length === 0) {
    console.log("\x1b[90mNo generations logged yet.\x1b[0m");
    return;
  }

  let totalCost = 0;
  let groundingCost = 0;
  let searchQueries = 0;
  let unpriced = 0;
  const byModel: Record<string, { count: number; cost: number }> = {};

  for (const e of entries) {
    const cost = e.estimated_cost ?? 0;
    if (e.estimated_cost == null) unpriced++;
    totalCost += cost;
    groundingCost += e.grounding_cost ?? 0;
    searchQueries += e.search_queries ?? 0;
    const m = e.model;
    if (!byModel[m]) byModel[m] = { count: 0, cost: 0 };
    byModel[m].count++;
    byModel[m].cost += cost;
  }

  console.log(`\x1b[36m[nano-banana]\x1b[0m Cost Summary`);
  console.log(`\x1b[90m${"─".repeat(50)}\x1b[0m`);
  console.log(`  Total generations: ${entries.length}`);
  console.log(`  Total cost:        \x1b[33m$${totalCost.toFixed(4)}\x1b[0m`);
  if (searchQueries > 0) {
    console.log(
      `  Incl. search:      $${groundingCost.toFixed(4)} (${searchQueries} queries, first 5,000/month free)`
    );
  }
  if (unpriced > 0) {
    console.log(`  \x1b[33mNot priced:        ${unpriced} generation(s) with an unknown model\x1b[0m`);
  }
  console.log("");

  for (const [model, data] of Object.entries(byModel)) {
    const shortName = model.includes("flash") ? "Nano Banana 2 (Flash)" : model.includes("pro") ? "Nano Banana Pro" : model;
    console.log(`  ${shortName}`);
    console.log(`    Generations: ${data.count}`);
    console.log(`    Cost:        $${data.cost.toFixed(4)}`);
  }

  console.log(`\x1b[90m${"─".repeat(50)}\x1b[0m`);
  console.log(`\x1b[90mLog: ${COST_LOG_PATH}\x1b[0m`);
}

// Returns null for models without known pricing instead of guessing.
function calculateCost(
  model: string,
  usage: TokenUsage,
  searchQueries: number
): CostBreakdown | null {
  const rates = COST_RATES[model];
  if (!rates) return null;
  const tokenCost =
    (usage.promptTokens * rates.input +
      usage.imageTokens * rates.imageOutput +
      (usage.textTokens + usage.thoughtsTokens) * rates.textOutput) /
    1_000_000;
  const groundingCost = searchQueries * SEARCH_QUERY_COST;
  return { tokenCost, groundingCost, total: tokenCost + groundingCost };
}

// Splits usageMetadata into billable buckets. Output tokens not reported as
// IMAGE are priced at the text rate: Flash returns only an IMAGE entry in
// candidatesTokensDetails and leaves ~380 tokens unlabeled (no text part, no
// thoughtsTokenCount), which matches the published per-image price. Without
// any breakdown, all output is treated as image tokens (the pricier rate).
function extractTokenUsage(usage: {
  promptTokenCount?: number;
  toolUsePromptTokenCount?: number;
  candidatesTokenCount?: number;
  candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
  thoughtsTokenCount?: number;
}): TokenUsage {
  const candidates = usage.candidatesTokenCount || 0;
  const details = usage.candidatesTokensDetails;
  const imageTokens = details
    ? details
        .filter((d) => d.modality === "IMAGE")
        .reduce((sum, d) => sum + (d.tokenCount || 0), 0)
    : candidates;
  return {
    promptTokens: (usage.promptTokenCount || 0) + (usage.toolUsePromptTokenCount || 0),
    imageTokens,
    textTokens: Math.max(candidates - imageTokens, 0),
    thoughtsTokens: usage.thoughtsTokenCount || 0,
  };
}

// ---------------------------------------------------------------------------
// Background removal - FFmpeg colorkey + despill
// ---------------------------------------------------------------------------

async function detectKeyColor(inputPath: string): Promise<string> {
  // Sample the top-left 4x4 patch and pick the most common color
  const raw = await runMagick([
    inputPath,
    "-crop", "4x4+0+0", "+repage",
    "-format", "%c",
    "histogram:info:-",
  ]);

  // Histogram output lines look like: "  16: (  5,249,  4) #05F904 srgb(...)"
  // Find the line with the highest count and extract the hex color
  let bestCount = 0;
  let bestColor = "00FF00"; // fallback pure green

  for (const line of raw.split("\n")) {
    const countMatch = line.match(/^\s*(\d+):/);
    const hexMatch = line.match(/#([0-9A-Fa-f]{6})/);
    if (countMatch && hexMatch) {
      const count = parseInt(countMatch[1], 10);
      if (count > bestCount) {
        bestCount = count;
        bestColor = hexMatch[1];
      }
    }
  }

  return bestColor;
}

async function removeBackground(inputPath: string): Promise<string> {
  const dir = inputPath.substring(0, inputPath.lastIndexOf("/"));
  const name = basename(inputPath, extname(inputPath));
  const outputPath = join(dir, `${name}.png`);
  const tempKeyed = join(dir, `${name}_keyed.png`);

  const cleanup = async () => {
    const { unlink } = await import("fs/promises");
    await unlink(tempKeyed).catch(() => {});
  };

  try {
    // Step 1: Auto-detect the green screen key color from corner pixels
    console.log(`  \x1b[90mDetecting key color...\x1b[0m`);
    const keyColor = await detectKeyColor(inputPath);
    console.log(`  \x1b[90mKey color: #${keyColor}\x1b[0m`);

    // Step 2: FFmpeg colorkey + despill
    // colorkey removes the background, despill removes green spill from edge RGB values
    console.log(`  \x1b[90mRunning FFmpeg colorkey + despill...\x1b[0m`);
    await runCommand("ffmpeg", [
      "-y", "-i", inputPath,
      "-vf", `colorkey=0x${keyColor}:0.25:0.08,despill=green`,
      tempKeyed,
    ]);

    // Step 3: Auto-crop transparent padding
    console.log(`  \x1b[90mTrimming...\x1b[0m`);
    await runMagick([
      tempKeyed,
      "-trim", "+repage",
      outputPath,
    ]);

    await cleanup();
    return outputPath;
  } catch (err) {
    await cleanup();
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("Failed to run ffmpeg") || msg.includes("ENOENT")) {
      console.error(`\x1b[31m  FFmpeg not found.\x1b[0m`);
      console.error(`  Install it: brew install ffmpeg`);
      throw new Error("FFmpeg is required for transparent mode. Install: brew install ffmpeg");
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): Options | "costs" {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
\x1b[36mNano Banana 2\x1b[0m - AI Image Generation CLI
Default: Gemini 3.1 Flash Image Preview (Nano Banana 2)

\x1b[33mUsage:\x1b[0m
  nano-banana "your prompt"
  nano-banana "your prompt" --output filename
  nano-banana "your prompt" --ref reference.png
  nano-banana "edit this image to be darker" -r input.png
  nano-banana "combine these styles" -r style1.png -r style2.png

\x1b[33mOptions:\x1b[0m
  -o, --output      Output filename (without extension) [default: nano-gen-{timestamp}]
  -s, --size        Image size: 512, 1K, 2K, or 4K [default: 1K]
  -a, --aspect      Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, etc. [default: model default]
  -m, --model       Model: flash/nb2, pro/nb-pro, or any model ID [default: flash]
  -d, --dir         Output directory [default: current directory]
  -r, --ref         Reference image(s) - can use multiple times
  -t, --transparent Generate on green screen, then remove background (FFmpeg colorkey + despill)
  --api-key         Gemini API key (overrides env/file)
  --costs           Show cost summary from generation history
  -h, --help        Show this help

\x1b[33mModels:\x1b[0m
  flash, nb2    Gemini 3.1 Flash Image Preview (default, fast, cheap)
  pro, nb-pro   Gemini 3 Pro Image Preview (highest quality, 2x cost)
  <model-id>    Any Gemini model ID (e.g. gemini-2.5-flash-image)

\x1b[33mSizes:\x1b[0m
  512   ~512x512   (~$0.045/image on Flash)
  1K    ~1024x1024 (~$0.067/image on Flash) [default]
  2K    ~2048x2048 (~$0.101/image on Flash)
  4K    ~4096x4096 (~$0.151/image on Flash)

\x1b[33mAspect Ratios:\x1b[0m
  1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 4:5, 5:4, 21:9

\x1b[33mExamples:\x1b[0m
  nano-banana "minimal dashboard UI with dark theme"
  nano-banana "make this image have a white background" -r screenshot.png
  nano-banana "combine these two UI styles" -r style1.png -r style2.png -o combined
  nano-banana "luxury product mockup" -o product -s 2K
  nano-banana "cinematic landscape" -a 16:9 -s 4K
  nano-banana "highest quality portrait" --model pro -a 9:16

\x1b[33mTransparent Assets:\x1b[0m
  nano-banana "robot mascot character" -t -o mascot
  nano-banana "pixel art treasure chest" -t -o chest
  nano-banana "minimalist tech logo" -t -o logo

\x1b[33mCost Tracking:\x1b[0m
  nano-banana --costs    Show total spend and per-model breakdown

\x1b[33mAPI Key:\x1b[0m
  Set GEMINI_API_KEY in your environment, a .env file, or pass --api-key.
  Get a key at: https://aistudio.google.com/apikey
`);
    process.exit(0);
  }

  // Handle --costs flag
  if (args[0] === "--costs") {
    return "costs";
  }

  const options: Options = {
    prompt: "",
    output: `nano-gen-${Date.now()}`,
    size: "1K",
    outputDir: process.cwd(),
    referenceImages: [],
    transparent: false,
    apiKey: undefined,
    model: DEFAULT_MODEL,
    aspectRatio: undefined,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-o" || arg === "--output") {
      options.output = args[++i];
    } else if (arg === "-s" || arg === "--size") {
      const size = args[++i];
      if (VALID_SIZES.includes(size as ImageSize)) {
        options.size = size as ImageSize;
      } else {
        console.error(`\x1b[31mError:\x1b[0m Invalid size "${size}". Valid: ${VALID_SIZES.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "-a" || arg === "--aspect") {
      const aspect = args[++i];
      if (VALID_ASPECTS.includes(aspect as (typeof VALID_ASPECTS)[number])) {
        options.aspectRatio = aspect;
      } else {
        console.error(`\x1b[31mError:\x1b[0m Invalid aspect ratio "${aspect}". Valid: ${VALID_ASPECTS.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "-m" || arg === "--model") {
      options.model = resolveModel(args[++i]);
    } else if (arg === "-d" || arg === "--dir") {
      options.outputDir = args[++i];
    } else if (arg === "-r" || arg === "--ref") {
      options.referenceImages.push(args[++i]);
    } else if (arg === "-t" || arg === "--transparent") {
      options.transparent = true;
    } else if (arg === "--api-key") {
      options.apiKey = args[++i];
    } else if (!arg.startsWith("-")) {
      options.prompt = arg;
    }
    i++;
  }

  if (!options.prompt) {
    console.error("\x1b[31mError:\x1b[0m No prompt provided");
    process.exit(1);
  }

  // Warn if 512 is used with Pro model
  if (options.size === "512" && options.model === "gemini-3-pro-image-preview") {
    console.log("\x1b[33mWarning:\x1b[0m 512px resolution is only available on Flash. Switching to 1K.");
    options.size = "1K";
  }

  return options;
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

async function generateImage(options: Options): Promise<string[]> {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;

  if (!options.apiKey && apiKeyFromForeignCwd) {
    console.error(`\x1b[33mWarning:\x1b[0m using GEMINI_API_KEY from ${cwdEnvPath}`);
    console.error("  This .env overrides ~/.nano-banana/.env. Costs go to that key's project.");
  }

  if (!apiKey) {
    console.error("\x1b[31mError:\x1b[0m GEMINI_API_KEY is required.");
    console.error("");
    console.error("Set it one of these ways:");
    console.error("  1. Export:    export GEMINI_API_KEY=your_key");
    console.error("  2. .env:     Create .env with GEMINI_API_KEY=your_key");
    console.error("  3. Flag:     nano-banana \"prompt\" --api-key your_key");
    console.error("  4. Config:   mkdir -p ~/.nano-banana && echo 'GEMINI_API_KEY=your_key' > ~/.nano-banana/.env");
    console.error("");
    console.error("Get a key at: https://aistudio.google.com/apikey");
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey });

  // Build imageConfig
  const imageConfig: Record<string, string> = {
    imageSize: options.size === "512" ? "512px" : options.size,
  };
  if (options.aspectRatio) {
    imageConfig.aspectRatio = options.aspectRatio;
  }

  const config = {
    responseModalities: ["IMAGE", "TEXT"] as const,
    imageConfig,
    tools: [{ googleSearch: {} }],
  };

  const modelName = options.model;
  const shortName = modelName.includes("flash")
    ? "Nano Banana 2 (Flash 3.1)"
    : modelName.includes("pro")
      ? "Nano Banana Pro"
      : modelName;

  console.log(`\x1b[36m[nano-banana]\x1b[0m Generating image...`);
  console.log(`\x1b[90mModel: ${shortName}\x1b[0m`);
  console.log(`\x1b[90mPrompt: ${options.prompt}\x1b[0m`);
  console.log(`\x1b[90mSize: ${options.size}${options.aspectRatio ? ` | Aspect: ${options.aspectRatio}` : ""}\x1b[0m`);

  if (options.referenceImages.length > 0) {
    console.log(
      `\x1b[90mReferences: ${options.referenceImages.join(", ")}\x1b[0m`
    );
  }
  console.log("");

  // Build parts array with images first, then text
  const parts: Array<
    { text: string } | { inlineData: { data: string; mimeType: string } }
  > = [];

  for (const imgPath of options.referenceImages) {
    try {
      const imageData = await loadImageAsBase64(imgPath);
      parts.push({ inlineData: imageData });
      console.log(`\x1b[32m+\x1b[0m Loaded reference: ${imgPath}`);
    } catch (err) {
      console.error(`\x1b[31mx\x1b[0m Failed to load: ${imgPath}`);
      throw err;
    }
  }

  // When transparent mode is on, wrap the prompt to request a green screen background
  const finalPrompt = options.transparent
    ? `${options.prompt}. Place the subject on a solid bright green background (#00FF00). The background must be a single flat green color with no gradients, shadows, or variation.`
    : options.prompt;

  parts.push({ text: finalPrompt });

  const contents = [{ role: "user" as const, parts }];

  // Use non-streaming to get usageMetadata for cost tracking
  const response = await ai.models.generateContent({
    model: modelName,
    config,
    contents,
  });

  const savedFiles: string[] = [];
  let fileIndex = 0;

  if (!existsSync(options.outputDir)) {
    await mkdir(options.outputDir, { recursive: true });
  }

  if (response.candidates && response.candidates[0]?.content?.parts) {
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        const inlineData = part.inlineData;
        const mimeType = inlineData.mimeType || "image/png";
        const ext = mimeType.split("/")[1] || "png";

        const fileName =
          fileIndex === 0
            ? `${options.output}.${ext}`
            : `${options.output}_${fileIndex}.${ext}`;

        const outputPath = join(options.outputDir, fileName);
        const buffer = Buffer.from(inlineData.data || "", "base64");

        await writeFile(outputPath, buffer);
        savedFiles.push(outputPath);
        fileIndex++;
      } else if (part.text) {
        console.log(`\x1b[90m${part.text}\x1b[0m`);
      }
    }
  }

  // Cost tracking
  const usage = response.usageMetadata;
  if (usage) {
    const tokens = extractTokenUsage(usage);
    const searchQueries =
      response.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length || 0;
    const cost = calculateCost(modelName, tokens, searchQueries);

    const tokenSummary =
      `${tokens.promptTokens} input, ${tokens.imageTokens} image, ` +
      `${tokens.textTokens} text, ${tokens.thoughtsTokens} thinking tokens`;
    if (cost) {
      const search =
        searchQueries > 0
          ? ` + ${searchQueries} search $${cost.groundingCost.toFixed(4)}, first 5,000/month free`
          : "";
      console.log(
        `\x1b[90mCost: ~$${cost.total.toFixed(4)} (tokens $${cost.tokenCost.toFixed(4)}${search}; ${tokenSummary})\x1b[0m`
      );
    } else {
      console.log(
        `\x1b[33mCost: unknown, no pricing for model ${modelName} (${tokenSummary}).\x1b[0m`
      );
    }

    // Log to file
    const entry: CostEntry = {
      timestamp: new Date().toISOString(),
      model: modelName,
      size: options.size,
      aspect: options.aspectRatio || null,
      prompt_tokens: tokens.promptTokens,
      output_tokens: usage.candidatesTokenCount || 0,
      image_tokens: tokens.imageTokens,
      text_tokens: tokens.textTokens,
      thoughts_tokens: tokens.thoughtsTokens,
      search_queries: searchQueries,
      grounding_cost: cost?.groundingCost ?? 0,
      estimated_cost: cost ? cost.total : null,
      output_file: savedFiles[0] || "",
    };

    await logCost(entry).catch(() => {
      // Non-fatal - don't fail generation if cost logging fails
    });
  }

  return savedFiles;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const parsed = parseArgs();

if (parsed === "costs") {
  printCostSummary();
  process.exit(0);
}

const options = parsed;

generateImage(options)
  .then(async (files) => {
    if (files.length === 0) {
      console.log("\x1b[33m[nano-banana]\x1b[0m No images generated");
      return;
    }

    let finalFiles = files;

    if (options.transparent) {
      console.log(
        `\n\x1b[36m[nano-banana]\x1b[0m Keying out green screen...`
      );
      const processedFiles: string[] = [];

      for (const file of files) {
        try {
          const outputPath = await removeBackground(file);
          processedFiles.push(outputPath);
          console.log(`  \x1b[32m+\x1b[0m Transparent: ${outputPath}`);
        } catch (err) {
          console.error(`  \x1b[31mx\x1b[0m Failed to process: ${file}`);
          processedFiles.push(file);
        }
      }

      finalFiles = processedFiles;
    }

    console.log(
      `\n\x1b[32m[nano-banana]\x1b[0m Generated ${finalFiles.length} image(s):`
    );
    finalFiles.forEach((f) => console.log(`  \x1b[32m+\x1b[0m ${f}`));
  })
  .catch((err) => {
    console.error("\x1b[31m[nano-banana] Error:\x1b[0m", err.message);
    process.exit(1);
  });
