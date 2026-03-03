import {
    pgTable,
    text,
    timestamp,
    integer,
    boolean,
    jsonb,
    real,
    uuid,
    index,
    varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Vector extension helper ─────────────────────────────────────────
// pgvector column — Neon supports this natively
const vector = (name: string, dimensions: number) =>
    text(name).$type<string>(); // stored as text, cast in queries

// ─── News Items ──────────────────────────────────────────────────────
export const newsItems = pgTable(
    "news_items",
    {
        id: uuid("id")
            .default(sql`gen_random_uuid()`)
            .primaryKey(),
        title: text("title").notNull(),
        url: text("url").notNull(),
        source: varchar("source", { length: 100 }).notNull(),
        category: varchar("category", { length: 50 }), // ai_tech, insurtech, fintech
        summary: text("summary"),
        content: text("content"),
        score: integer("score"), // 1-10 relevance score
        entities: jsonb("entities").$type<string[]>(),
        embedding: vector("embedding", 1536),
        vertical: varchar("vertical", { length: 50 }),
        processed: boolean("processed").default(false),
        cycleId: varchar("cycle_id", { length: 50 }),
        publishedAt: timestamp("published_at"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
        index("news_score_idx").on(table.score),
        index("news_created_idx").on(table.createdAt),
        index("news_processed_idx").on(table.processed),
    ]
);

// ─── LinkedIn Profiles ───────────────────────────────────────────────
export const linkedinProfiles = pgTable("linkedin_profiles", {
    id: uuid("id")
        .default(sql`gen_random_uuid()`)
        .primaryKey(),
    name: text("name").notNull(),
    linkedinUrl: text("linkedin_url").notNull().unique(),
    type: varchar("type", { length: 20 }).notNull(), // competitor, prospect, ally
    company: text("company"),
    title: text("title"),
    active: boolean("active").default(true),
    lastScrapedAt: timestamp("last_scraped_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── LinkedIn Posts ──────────────────────────────────────────────────
export const linkedinPosts = pgTable(
    "linkedin_posts",
    {
        id: uuid("id")
            .default(sql`gen_random_uuid()`)
            .primaryKey(),
        profileId: uuid("profile_id").references(() => linkedinProfiles.id),
        postUrl: text("post_url"),
        content: text("content"),
        likes: integer("likes").default(0),
        comments: integer("comments").default(0),
        shares: integer("shares").default(0),
        engagement: integer("engagement").default(0), // computed total
        sentiment: varchar("sentiment", { length: 20 }),
        topics: jsonb("topics").$type<string[]>(),
        analysis: text("analysis"), // AI-generated analysis
        embedding: vector("embedding", 1536),
        processed: boolean("processed").default(false),
        cycleId: varchar("cycle_id", { length: 50 }),
        postedAt: timestamp("posted_at"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
        index("li_posts_profile_idx").on(table.profileId),
        index("li_posts_engagement_idx").on(table.engagement),
        index("li_posts_created_idx").on(table.createdAt),
    ]
);

// ─── Intelligence Briefings ──────────────────────────────────────────
export const intelligenceBriefings = pgTable("intelligence_briefings", {
    id: uuid("id")
        .default(sql`gen_random_uuid()`)
        .primaryKey(),
    cycleId: varchar("cycle_id", { length: 50 }).notNull(),
    content: text("content").notNull(), // Full markdown briefing
    topInsights: jsonb("top_insights").$type<
        { title: string; summary: string; impact: string }[]
    >(),
    opportunities: jsonb("opportunities").$type<
        { description: string; urgency: string }[]
    >(),
    competitorAlerts: jsonb("competitor_alerts").$type<
        { company: string; alert: string }[]
    >(),
    newsCount: integer("news_count").default(0),
    linkedinPostsCount: integer("linkedin_posts_count").default(0),
    deliveredToDiscord: boolean("delivered_to_discord").default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Daily Publications ──────────────────────────────────────────────
export const dailyPublications = pgTable(
    "daily_publications",
    {
        id: uuid("id")
            .default(sql`gen_random_uuid()`)
            .primaryKey(),
        title: text("title"),
        content: text("content").notNull(), // Full LinkedIn post text
        format: varchar("format", { length: 30 }), // carousel, image, article, document
        hookVariants: jsonb("hook_variants").$type<string[]>(),
        imagePrompt: text("image_prompt"),
        imageUrl: text("image_url"),
        topic: text("topic"),
        status: varchar("status", { length: 20 })
            .default("draft")
            .notNull(), // draft, pending, approved, rejected, published
        approvedAt: timestamp("approved_at"),
        rejectedReason: text("rejected_reason"),
        discordMessageId: text("discord_message_id"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
        index("pub_status_idx").on(table.status),
        index("pub_created_idx").on(table.createdAt),
    ]
);

// ─── Comment Suggestions ─────────────────────────────────────────────
export const commentSuggestions = pgTable("comment_suggestions", {
    id: uuid("id")
        .default(sql`gen_random_uuid()`)
        .primaryKey(),
    briefingId: uuid("briefing_id").references(() => intelligenceBriefings.id),
    targetPostUrl: text("target_post_url"),
    targetProfileName: text("target_profile_name"),
    relationshipType: varchar("relationship_type", { length: 20 }), // competitor, prospect, ally
    comment: text("comment").notNull(),
    tone: varchar("tone", { length: 30 }), // diferenciador, consultivo, diplomático
    status: varchar("status", { length: 20 }).default("suggested"), // suggested, approved, used
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Pipeline Runs ───────────────────────────────────────────────────
export const pipelineRuns = pgTable(
    "pipeline_runs",
    {
        id: uuid("id")
            .default(sql`gen_random_uuid()`)
            .primaryKey(),
        cycleId: varchar("cycle_id", { length: 50 }).notNull(),
        phase: varchar("phase", { length: 50 }).notNull(), // collect-news, collect-linkedin, process, deliver, generate
        status: varchar("status", { length: 20 }).notNull(), // running, success, error
        itemsProcessed: integer("items_processed").default(0),
        tokensUsed: integer("tokens_used").default(0),
        costUsd: real("cost_usd").default(0),
        duration: integer("duration_ms"),
        error: text("error"),
        metadata: jsonb("metadata"),
        startedAt: timestamp("started_at").defaultNow().notNull(),
        completedAt: timestamp("completed_at"),
    },
    (table) => [
        index("run_cycle_idx").on(table.cycleId),
        index("run_phase_idx").on(table.phase),
    ]
);

// ─── Type exports ────────────────────────────────────────────────────
export type NewsItem = typeof newsItems.$inferSelect;
export type NewNewsItem = typeof newsItems.$inferInsert;
export type LinkedinProfile = typeof linkedinProfiles.$inferSelect;
export type LinkedinPost = typeof linkedinPosts.$inferSelect;
export type IntelligenceBriefing = typeof intelligenceBriefings.$inferSelect;
export type DailyPublication = typeof dailyPublications.$inferSelect;
export type CommentSuggestion = typeof commentSuggestions.$inferSelect;
export type PipelineRun = typeof pipelineRuns.$inferSelect;
