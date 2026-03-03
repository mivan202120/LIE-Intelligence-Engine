// ─── Schedule Config ─────────────────────────────────────────────────
export const SCHEDULE = {
    timezone: "America/Mexico_City",
    intelligenceCycles: 2, // per day
    contentTime: "05:00", // CDMX time
    deliveryTime: "07:00",
} as const;

// ─── Verticals ──────────────────────────────────────────────────────
export interface Vertical {
    name: string;
    keywords: string[];
    rssFeeds: string[];
    newsapiQuery: string;
}

export const VERTICALS: Vertical[] = [
    {
        name: "AI/Tech Global",
        keywords: [
            "artificial intelligence",
            "OpenAI",
            "Google AI",
            "LLM",
            "GPT",
            "machine learning",
            "AI agents",
            "Claude",
            "Anthropic",
        ],
        rssFeeds: [
            "https://techcrunch.com/feed/",
            "https://www.theverge.com/rss/index.xml",
            "https://www.wired.com/feed/rss",
        ],
        newsapiQuery: "artificial intelligence OR OpenAI OR LLM",
    },
    {
        name: "Insurtech & Insurance LATAM",
        keywords: [
            "insurtech",
            "seguros digitales",
            "AI insurance",
            "claims automation",
            "underwriting AI",
            "reaseguro digital",
            "FIDES",
        ],
        rssFeeds: [
            "https://www.insurancejournal.com/feed/",
            "https://www.reinsurancene.ws/feed/",
        ],
        newsapiQuery: "insurtech OR insurance technology OR AI seguros",
    },
    {
        name: "Fintech & Financial Services",
        keywords: [
            "fintech LATAM",
            "digital banking",
            "embedded finance",
            "open banking",
            "neobank",
        ],
        rssFeeds: [],
        newsapiQuery: "fintech LATAM OR digital banking",
    },
];

// ─── Thresholds ─────────────────────────────────────────────────────
export const THRESHOLDS = {
    minNewsScore: 6,
    duplicateSimilarity: 0.92,
    maxNewsPerCycle: 50,
    maxLinkedinPostsPerCycle: 200,
    minLinkedinEngagementAlert: 100,
    maxCommentsPerCycle: 5,
} as const;

// ─── Voice & Style ──────────────────────────────────────────────────
export const VOICE = {
    tone: "provocador + educador con datos duros",
    language: "es",
    signatureData: "47+ carriers en LATAM",
    hookStyle: "Abre con dato impactante o afirmación contraintuitiva",
    structure: "Hook → Contexto con datos → Análisis desde experiencia → Insight → CTA",
    avoid: [
        "Excesivamente corporativo",
        "Genérico sin datos",
        "Tono de vendedor",
    ],
} as const;

// ─── Comment Tones ──────────────────────────────────────────────────
export const COMMENT_TONES = {
    competitor: {
        tone: "diferenciador",
        instruction: "Diferenciador sutil — mostrar experiencia sin atacar directamente",
    },
    prospect: {
        tone: "consultivo",
        instruction: "Consultivo — aportar valor genuino sin vender",
    },
    ally: {
        tone: "diplomático",
        instruction: "Diplomático — fortalecer relación y crear oportunidades",
    },
} as const;

// ─── Cycle ID Generator ────────────────────────────────────────────
export function generateCycleId(): string {
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const hour = now.getUTCHours().toString().padStart(2, "0");
    return `${date}-${hour}`;
}
