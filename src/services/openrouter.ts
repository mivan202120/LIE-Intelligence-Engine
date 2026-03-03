import OpenAI from "openai";

// ─── Model Configuration ────────────────────────────────────────────
export const MODELS = {
    // 🧠 Brain — strategic decisions, content generation, analysis
    brain: {
        primary: "anthropic/claude-sonnet-4",
        fallback: "anthropic/claude-3.5-sonnet",
    },
    // 💪 Muscle — classification, scoring, extraction (cheap + fast)
    muscle: {
        primary: "google/gemini-2.0-flash-001",
        fallback: "openai/gpt-4o-mini",
    },
    // 🔢 Embeddings — deduplication and semantic search
    embed: {
        primary: "openai/text-embedding-3-small",
    },
    // 🎨 Image — editorial image generation
    image: {
        primary: "google/gemini-2.5-flash-image",
        fallback: "openai/gpt-5-image-mini",
    },
} as const;

// ─── OpenRouter Client ──────────────────────────────────────────────
const openrouter = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": "https://lie-engine.vercel.app",
        "X-Title": "LIE Intelligence Engine",
    },
});

// ─── Types ──────────────────────────────────────────────────────────
type ModelRole = "brain" | "muscle";

interface CompletionOptions {
    role: ModelRole;
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
}

interface CompletionResult {
    content: string;
    model: string;
    tokensUsed: { input: number; output: number };
    costUsd: number;
}

interface EmbeddingResult {
    embedding: number[];
    model: string;
    tokensUsed: number;
}

interface ImageResult {
    imageUrl: string;
    model: string;
}

// ─── Brain & Muscle Completion ──────────────────────────────────────
export async function complete(
    options: CompletionOptions
): Promise<CompletionResult> {
    const { role, system, prompt, temperature = 0.7, maxTokens = 4096, jsonMode = false } = options;
    const modelConfig = MODELS[role];

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (system) {
        messages.push({ role: "system", content: system });
    }
    messages.push({ role: "user", content: prompt });

    try {
        const response = await openrouter.chat.completions.create({
            model: modelConfig.primary,
            messages,
            temperature,
            max_tokens: maxTokens,
            ...(jsonMode && { response_format: { type: "json_object" } }),
        });

        const choice = response.choices[0];
        const usage = response.usage;

        return {
            content: choice?.message?.content ?? "",
            model: response.model ?? modelConfig.primary,
            tokensUsed: {
                input: usage?.prompt_tokens ?? 0,
                output: usage?.completion_tokens ?? 0,
            },
            costUsd: 0, // OpenRouter provides this in headers but not easily accessible
        };
    } catch (error) {
        // Fallback to secondary model
        console.warn(
            `[OpenRouter] Primary model ${modelConfig.primary} failed, trying fallback ${modelConfig.fallback}`,
            error
        );

        const response = await openrouter.chat.completions.create({
            model: modelConfig.fallback,
            messages,
            temperature,
            max_tokens: maxTokens,
            ...(jsonMode && { response_format: { type: "json_object" } }),
        });

        const choice = response.choices[0];
        const usage = response.usage;

        return {
            content: choice?.message?.content ?? "",
            model: response.model ?? modelConfig.fallback,
            tokensUsed: {
                input: usage?.prompt_tokens ?? 0,
                output: usage?.completion_tokens ?? 0,
            },
            costUsd: 0,
        };
    }
}

// ─── Embeddings ─────────────────────────────────────────────────────
export async function embed(text: string): Promise<EmbeddingResult> {
    const response = await openrouter.embeddings.create({
        model: MODELS.embed.primary,
        input: text,
    });

    return {
        embedding: response.data[0].embedding,
        model: MODELS.embed.primary,
        tokensUsed: response.usage?.total_tokens ?? 0,
    };
}

// ─── Batch Embeddings ───────────────────────────────────────────────
export async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await openrouter.embeddings.create({
        model: MODELS.embed.primary,
        input: texts,
    });

    return response.data.map((item) => ({
        embedding: item.embedding,
        model: MODELS.embed.primary,
        tokensUsed: Math.floor(
            (response.usage?.total_tokens ?? 0) / texts.length
        ),
    }));
}

// ─── Image Generation (Together AI — FLUX) ──────────────────────────
export async function generateImage(
    prompt: string
): Promise<ImageResult> {
    const imagePrompt = "Professional editorial image for LinkedIn. " +
        "Style: modern, clean, abstract-tech. Dark blue/purple palette. " +
        "NO text, NO words, NO letters, NO human faces. " +
        "Abstract data visualization aesthetic. " + prompt;

    // Try Together AI FLUX first 
    const togetherKey = process.env.TOGETHER_API_KEY;
    if (togetherKey) {
        try {
            const response = await fetch("https://api.together.xyz/v1/images/generations", {
                method: "POST",
                headers: {
                    "Authorization": "Bearer " + togetherKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: "black-forest-labs/FLUX.1.1-pro",
                    prompt: imagePrompt,
                    width: 1024,
                    height: 1024,
                    n: 1,
                    response_format: "url",
                }),
            });

            if (response.ok) {
                const data = await response.json() as {
                    data: { url?: string; b64_json?: string }[];
                };
                const imageUrl = data.data?.[0]?.url;
                if (imageUrl) {
                    return { imageUrl, model: "together/flux-1.1-pro" };
                }
                // If URL not available, try base64
                const b64 = data.data?.[0]?.b64_json;
                if (b64) {
                    return { imageUrl: "data:image/png;base64," + b64, model: "together/flux-1.1-pro" };
                }
            }
            console.warn("[Image] Together AI FLUX response not ok:", response.status);
        } catch (err) {
            console.warn("[Image] Together AI FLUX failed:", err);
        }
    }

    // Fallback: OpenAI DALL-E 3 via OpenRouter
    try {
        const response = await fetch("https://openrouter.ai/api/v1/images/generations", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + process.env.OPENROUTER_API_KEY,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "openai/dall-e-3",
                prompt: imagePrompt,
                n: 1,
                size: "1024x1024",
            }),
        });

        if (response.ok) {
            const data = await response.json() as {
                data: { url?: string; b64_json?: string }[];
            };
            const imageUrl = data.data?.[0]?.url;
            if (imageUrl) {
                return { imageUrl, model: "openai/dall-e-3" };
            }
        }
        console.warn("[Image] DALL-E 3 via OpenRouter failed:", response.status);
    } catch (err) {
        console.warn("[Image] DALL-E 3 fallback failed:", err);
    }

    return { imageUrl: "", model: "none" };
}

// ─── Cosine Similarity ─────────────────────────────────────────────
export function cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
