import { NextResponse } from "next/server";
import { db } from "@/db";
import { newsItems, pipelineRuns } from "@/db/schema";
import { complete, embed, cosineSimilarity } from "@/services/openrouter";
import { sendEmbed, createLogEmbed, CHANNELS } from "@/services/discord";
import { VERTICALS, THRESHOLDS, generateCycleId } from "@/config";
import { CLASSIFICATION_SYSTEM, CLASSIFICATION_PROMPT } from "@/prompts";
import { safeJsonParse, type RSSItem, type ClassificationResult } from "@/lib/types";
import { sql } from "drizzle-orm";

// Dynamically import rss-parser (CJS module)
async function parseRSS(url: string): Promise<RSSItem[]> {
    const Parser = (await import("rss-parser")).default;
    const parser = new Parser({ timeout: 10000 });
    try {
        const feed = await parser.parseURL(url);
        return (feed.items || []).map((item) => ({
            title: item.title || "",
            link: item.link || "",
            content: item.contentSnippet || item.content || "",
            contentSnippet: item.contentSnippet,
            pubDate: item.pubDate,
            creator: item.creator,
            source: new URL(url).hostname.replace("www.", ""),
        }));
    } catch (error) {
        console.error(`[RSS] Failed to parse ${url}:`, error);
        return [];
    }
}

async function fetchNewsAPI(query: string): Promise<RSSItem[]> {
    const apiKey = process.env.NEWSAPI_KEY;
    if (!apiKey) return [];

    try {
        const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=10&apiKey=${apiKey}`;
        const res = await fetch(url);
        const data = await res.json();

        return (data.articles || []).map(
            (a: { title: string; url: string; description: string; publishedAt: string; source: { name: string } }) => ({
                title: a.title || "",
                link: a.url || "",
                content: a.description || "",
                pubDate: a.publishedAt,
                source: a.source?.name || "newsapi",
            })
        );
    } catch (error) {
        console.error("[NewsAPI] Fetch failed:", error);
        return [];
    }
}

export async function GET(request: Request) {
    // Verify cron secret
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cycleId = generateCycleId();
    const startTime = Date.now();
    let itemsProcessed = 0;
    let totalTokens = 0;

    try {
        // Log start
        await db.insert(pipelineRuns).values({
            cycleId,
            phase: "collect-news",
            status: "running",
            startedAt: new Date(),
        });

        // 1. Collect RSS feeds from all verticals
        const allItems: RSSItem[] = [];
        for (const vertical of VERTICALS) {
            for (const feedUrl of vertical.rssFeeds) {
                const items = await parseRSS(feedUrl);
                allItems.push(
                    ...items.map((item) => ({ ...item, source: `${item.source} (${vertical.name})` }))
                );
            }

            // NewsAPI for this vertical
            if (vertical.newsapiQuery) {
                const newsApiItems = await fetchNewsAPI(vertical.newsapiQuery);
                allItems.push(...newsApiItems);
            }
        }

        console.log(`[News] Collected ${allItems.length} raw items`);

        // 2. Deduplicate + classify
        const existingEmbeddings: { embedding: number[]; id: string }[] = [];

        // Get recent embeddings for dedup
        const recentNews = await db
            .select({ id: newsItems.id, embedding: newsItems.embedding })
            .from(newsItems)
            .where(sql`${newsItems.createdAt} > NOW() - INTERVAL '48 hours'`)
            .limit(200);

        for (const n of recentNews) {
            if (n.embedding) {
                try {
                    existingEmbeddings.push({ id: n.id, embedding: JSON.parse(n.embedding) });
                } catch { /* skip invalid */ }
            }
        }

        for (const item of allItems.slice(0, THRESHOLDS.maxNewsPerCycle)) {
            // Generate embedding for dedup
            const embResult = await embed(`${item.title} ${item.content?.slice(0, 500)}`);
            totalTokens += embResult.tokensUsed;

            // Check for duplicates
            let isDuplicate = false;
            for (const existing of existingEmbeddings) {
                if (cosineSimilarity(embResult.embedding, existing.embedding) > THRESHOLDS.duplicateSimilarity) {
                    isDuplicate = true;
                    break;
                }
            }

            if (isDuplicate) continue;

            // Classify with muscle model
            const classification = await complete({
                role: "muscle",
                system: CLASSIFICATION_SYSTEM,
                prompt: CLASSIFICATION_PROMPT(item.title, item.content),
                temperature: 0.3,
                maxTokens: 500,
                jsonMode: true,
            });

            totalTokens += classification.tokensUsed.input + classification.tokensUsed.output;
            const parsed = safeJsonParse<ClassificationResult>(classification.content);

            if (!parsed || parsed.score < THRESHOLDS.minNewsScore) continue;

            // Store classified news
            await db.insert(newsItems).values({
                title: item.title,
                url: item.link,
                source: item.source,
                category: parsed.category,
                summary: parsed.summary,
                content: item.content,
                score: parsed.score,
                entities: parsed.entities,
                embedding: JSON.stringify(embResult.embedding),
                processed: false,
                cycleId,
                publishedAt: item.pubDate ? new Date(item.pubDate) : null,
            });

            existingEmbeddings.push({ id: "new", embedding: embResult.embedding });
            itemsProcessed++;
        }

        const duration = Date.now() - startTime;

        // Update pipeline run
        await db
            .insert(pipelineRuns)
            .values({
                cycleId,
                phase: "collect-news",
                status: "success",
                itemsProcessed,
                tokensUsed: totalTokens,
                duration,
                startedAt: new Date(startTime),
                completedAt: new Date(),
            });

        // Log to Discord
        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed(
                "collect-news",
                "success",
                `Recolectadas **${allItems.length}** noticias → **${itemsProcessed}** clasificadas y almacenadas (score ≥ ${THRESHOLDS.minNewsScore})`,
                duration
            )
        );

        return NextResponse.json({
            success: true,
            cycleId,
            rawItems: allItems.length,
            storedItems: itemsProcessed,
            tokensUsed: totalTokens,
            durationMs: duration,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[News Collector] Error:", errMsg);

        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed("collect-news", "error", `Error: ${errMsg}`, Date.now() - startTime)
        );

        return NextResponse.json({ error: errMsg }, { status: 500 });
    }
}
