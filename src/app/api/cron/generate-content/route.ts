import { NextResponse } from "next/server";
import { db } from "@/db";
import {
    newsItems,
    linkedinPosts,
    intelligenceBriefings,
    dailyPublications,
    pipelineRuns,
} from "@/db/schema";
import { complete, generateImage } from "@/services/openrouter";
import {
    sendEmbed,
    createPublicationEmbed,
    createLogEmbed,
    CHANNELS,
} from "@/services/discord";
import { generateCycleId } from "@/config";
import { CONTENT_SYSTEM, CONTENT_PROMPT } from "@/prompts";
import { safeJsonParse, type ContentResult } from "@/lib/types";
import { desc, sql } from "drizzle-orm";

export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cycleId = generateCycleId();
    const startTime = Date.now();

    try {
        try {
            await db.insert(pipelineRuns).values({
                cycleId,
                phase: "generate-content",
                status: "running",
                startedAt: new Date(),
            });
        } catch (logErr) {
            console.warn("[Content] Failed to log pipeline start:", logErr);
        }

        // 1. Gather last 24h of intelligence
        const recentNews = await db
            .select()
            .from(newsItems)
            .where(sql`${newsItems.createdAt} > NOW() - INTERVAL '24 hours'`)
            .orderBy(desc(newsItems.score))
            .limit(20);

        const recentPosts = await db
            .select()
            .from(linkedinPosts)
            .where(sql`${linkedinPosts.createdAt} > NOW() - INTERVAL '24 hours'`)
            .orderBy(desc(linkedinPosts.engagement))
            .limit(15);

        const recentBriefings = await db
            .select()
            .from(intelligenceBriefings)
            .where(sql`${intelligenceBriefings.createdAt} > NOW() - INTERVAL '24 hours'`)
            .orderBy(desc(intelligenceBriefings.createdAt))
            .limit(3);

        // 2. Compile intelligence summary for the brain
        const intelligenceSummary = [
            "=== TOP NEWS ===",
            ...recentNews.map(
                (n) => `[Score: ${n.score}] ${n.title}\n${n.summary || ""}`
            ),
            "\n=== LINKEDIN HIGHLIGHTS ===",
            ...recentPosts
                .slice(0, 10)
                .map(
                    (p) =>
                        `[Engagement: ${p.engagement}] ${p.content?.slice(0, 200) || ""}`
                ),
            "\n=== BRIEFING INSIGHTS ===",
            ...recentBriefings.map((b) => b.content?.slice(0, 500) || ""),
        ].join("\n");

        // 3. Ask brain to select topic and generate content
        const topicSelection = await complete({
            role: "brain",
            system: CONTENT_SYSTEM,
            prompt: `Based on the following 24h intelligence, select THE SINGLE MOST impactful topic for a LinkedIn publication today. Consider what will generate the most engagement and establish thought leadership.

${intelligenceSummary}

First, decide the optimal format:
- "image_post": A powerful text post with a supporting editorial image (most common)
- "article": A long-form analysis piece
- "carousel": Multiple insights that need visual structure

Respond in JSON: {"topic": "<selected topic>", "format": "<format>", "reasoning": "<why this topic today>"}`,
            temperature: 0.8,
            maxTokens: 500,
            jsonMode: true,
        });

        const topicParsed = safeJsonParse<{
            topic: string;
            format: string;
            reasoning: string;
        }>(topicSelection.content);

        const selectedTopic = topicParsed?.topic || "AI transforming insurance in LATAM";
        const selectedFormat = topicParsed?.format || "image_post";

        // 4. Generate the full publication
        const contentResult = await complete({
            role: "brain",
            system: CONTENT_SYSTEM,
            prompt: CONTENT_PROMPT(selectedTopic, intelligenceSummary, selectedFormat),
            temperature: 0.85,
            maxTokens: 4096,
            jsonMode: true,
        });

        const content = safeJsonParse<ContentResult>(contentResult.content);

        if (!content) {
            throw new Error("Failed to parse content result");
        }

        // 5. Generate editorial image
        let imageUrl: string | undefined;
        if (content.imagePrompt) {
            try {
                const imageResult = await generateImage(content.imagePrompt);
                imageUrl = imageResult.imageUrl;
            } catch (imgError) {
                console.warn("[Content] Image generation failed:", imgError);
            }
        }

        // 6. Store publication
        const [publication] = await db
            .insert(dailyPublications)
            .values({
                title: content.title,
                content: content.content,
                format: content.format || selectedFormat,
                hookVariants: content.hookVariants,
                imagePrompt: content.imagePrompt,
                imageUrl,
                topic: selectedTopic,
                status: "pending",
            })
            .returning();

        // 7. Send to Discord #daily-publication with approval buttons
        const { embed, buttons } = createPublicationEmbed({
            id: publication.id,
            title: content.title,
            content: content.content,
            format: content.format || selectedFormat,
            imageUrl,
            hookVariants: content.hookVariants,
        });

        await sendEmbed(CHANNELS.CONTENT, embed, [buttons]);

        const duration = Date.now() - startTime;

        // Log success (non-blocking — errors here should NOT mask the success)
        try {
            await db.insert(pipelineRuns).values({
                cycleId,
                phase: "generate-content",
                status: "success",
                itemsProcessed: 1,
                tokensUsed:
                    topicSelection.tokensUsed.input +
                    topicSelection.tokensUsed.output +
                    contentResult.tokensUsed.input +
                    contentResult.tokensUsed.output,
                duration,
                startedAt: new Date(startTime),
                completedAt: new Date(),
            });
        } catch (logErr) {
            console.warn("[Content] Failed to log pipeline run:", logErr);
        }

        try {
            await sendEmbed(
                CHANNELS.LOGS,
                createLogEmbed(
                    "generate-content",
                    "success",
                    "Publicación generada: " + content.title + "\nFormato: " + (content.format || selectedFormat) + "\nTema: " + selectedTopic + "\n" + (imageUrl ? "Con imagen" : "Sin imagen"),
                    duration
                )
            );
        } catch (logErr) {
            console.warn("[Content] Failed to send Discord log:", logErr);
        }

        return NextResponse.json({
            success: true,
            publicationId: publication.id,
            topic: selectedTopic,
            format: selectedFormat,
            hasImage: !!imageUrl,
            durationMs: duration,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[Generate Content] Error:", errMsg);

        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed("generate-content", "error", `Error: ${errMsg}`, Date.now() - startTime)
        );

        return NextResponse.json({ error: errMsg }, { status: 500 });
    }
}
