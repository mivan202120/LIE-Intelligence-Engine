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

// ─── Image Generation (OpenRouter — GPT-5 Image Mini) ───────────────
export async function generateImage(
    prompt: string
): Promise<ImageResult> {
    const imagePrompt = "Generate an image (NO text description, ONLY the image): " +
        "Professional editorial image for LinkedIn. " +
        "Style: modern, clean, abstract-tech. Dark blue and purple palette. " +
        "NO text, NO words, NO letters, NO human faces. " +
        "Abstract data visualization aesthetic. " + prompt;

    const models = [
        "openai/gpt-5-image-mini",
        "google/gemini-2.5-flash-image",
    ];

    for (const model of models) {
        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": "Bearer " + process.env.OPENROUTER_API_KEY,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: "user", content: imagePrompt }],
                }),
            });

            if (!response.ok) {
                console.warn(`[Image] ${model} HTTP error:`, response.status);
                continue;
            }

            const data = await response.json() as {
                choices: {
                    message: {
                        content?: string;
                        images?: string[];
                    };
                }[];
            };

            const msg = data.choices?.[0]?.message;
            if (!msg) continue;

            // OpenRouter returns images in message.images array (base64 strings)
            if (msg.images && msg.images.length > 0) {
                const b64 = msg.images[0];
                return {
                    imageUrl: "base64:image/png:" + b64,
                    model,
                };
            }

            // Some models return inline data URIs in content
            const content = msg.content ?? "";
            const dataMatch = content.match(/(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
            if (dataMatch) {
                return { imageUrl: dataMatch[1], model };
            }

            // Check for URLs in content
            const urlMatch = content.match(/(https?:\/\/[^\s"'<>]+\.(png|jpg|jpeg|webp|gif)[^\s"'<>]*)/i);
            if (urlMatch) {
                return { imageUrl: urlMatch[1], model };
            }

            console.warn(`[Image] ${model} returned no image data`);
        } catch (err) {
            console.warn(`[Image] ${model} failed:`, err);
        }
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
