// ─── Types ──────────────────────────────────────────────────────────
export interface RSSItem {
    title: string;
    link: string;
    content: string;
    contentSnippet?: string;
    pubDate?: string;
    creator?: string;
    source: string;
}

export interface ClassificationResult {
    score: number;
    category: string;
    entities: string[];
    summary: string;
}

export interface BriefingResult {
    topInsights: { title: string; summary: string; impact: string }[];
    opportunities: { description: string; urgency: string }[];
    competitorAlerts: { company: string; alert: string }[];
    fullBriefing: string;
}

export interface ContentResult {
    title: string;
    content: string;
    hookVariants: string[];
    imagePrompt: string;
    format: string;
}

export interface CommentResult {
    comment: string;
    tone: string;
}

export interface PipelineContext {
    cycleId: string;
    startedAt: Date;
    phase: string;
}

// ─── Utility Functions ──────────────────────────────────────────────
export function safeJsonParse<T>(str: string): T | null {
    try {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = str.match(/```json\s*([\s\S]*?)```/) || str.match(/```\s*([\s\S]*?)```/);
        const cleaned = jsonMatch ? jsonMatch[1].trim() : str.trim();
        return JSON.parse(cleaned);
    } catch {
        return null;
    }
}

export function truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + "...";
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
