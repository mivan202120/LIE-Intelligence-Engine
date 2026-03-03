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

// ─── Image Generation (Google Imagen 3) ─────────────────────────────
export async function generateImage(
    prompt: string
): Promise<ImageResult> {
    const imagePrompt = "Professional editorial image for LinkedIn. " +
        "Style: modern, clean, abstract-tech. Dark blue and purple palette. " +
        "NO text, NO words, NO letters, NO human faces. " +
        "Abstract data visualization aesthetic. " + prompt;

    const googleKey = process.env.GOOGLE_AI_KEY;
    if (!googleKey) {
        console.warn("[Image] No GOOGLE_AI_KEY configured");
        return { imageUrl: "", model: "none" };
    }

    try {
        const response = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=" + googleKey,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    instances: [{ prompt: imagePrompt }],
                    parameters: {
                        sampleCount: 1,
                        aspectRatio: "1:1",
                        safetyFilterLevel: "BLOCK_MEDIUM_AND_ABOVE",
                    },
                }),
            }
        );

        if (!response.ok) {
            const errText = await response.text();
            console.warn("[Image] Imagen 3 API error:", response.status, errText);
            return { imageUrl: "", model: "none" };
        }

        const data = await response.json() as {
            predictions?: { bytesBase64Encoded: string; mimeType: string }[];
        };

        const prediction = data.predictions?.[0];
        if (prediction?.bytesBase64Encoded) {
            const mimeType = prediction.mimeType || "image/png";
            return {
                imageUrl: "base64:" + mimeType + ":" + prediction.bytesBase64Encoded,
                model: "google/imagen-3",
            };
        }

        console.warn("[Image] Imagen 3 returned no predictions");
        return { imageUrl: "", model: "none" };
    } catch (err) {
        console.warn("[Image] Imagen 3 failed:", err);
        return { imageUrl: "", model: "none" };
    }
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
