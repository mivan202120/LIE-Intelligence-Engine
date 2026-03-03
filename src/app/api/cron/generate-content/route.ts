import { NextResponse } from "next/server";
import { db } from "@/db";
import {
    newsItems,
    linkedinPosts,
    intelligenceBriefings,
    dailyPublications,
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
    const errors: string[] = [];

    // 1. Gather last 24h of intelligence
    let recentNews: { title: string; summary: string | null; score: number | null }[] = [];
    let recentPosts: { content: string | null; engagement: number | null }[] = [];
    let recentBriefings: { content: string }[] = [];

    try {
        recentNews = await db
            .select({ title: newsItems.title, summary: newsItems.summary, score: newsItems.score })
            .from(newsItems)
            .where(sql`${newsItems.createdAt} > NOW() - INTERVAL '24 hours'`)
            .orderBy(desc(newsItems.score))
            .limit(20);
    } catch (e) {
        errors.push("news_query: " + (e instanceof Error ? e.message : String(e)));
    }

    try {
        recentPosts = await db
            .select({ content: linkedinPosts.content, engagement: linkedinPosts.engagement })
            .from(linkedinPosts)
            .where(sql`${linkedinPosts.createdAt} > NOW() - INTERVAL '24 hours'`)
            .orderBy(desc(linkedinPosts.engagement))
            .limit(15);
    } catch (e) {
        errors.push("linkedin_query: " + (e instanceof Error ? e.message : String(e)));
    }

    try {
        recentBriefings = await db
            .select({ content: intelligenceBriefings.content })
            .from(intelligenceBriefings)
            .where(sql`${intelligenceBriefings.createdAt} > NOW() - INTERVAL '24 hours'`)
            .orderBy(desc(intelligenceBriefings.createdAt))
            .limit(3);
    } catch (e) {
        errors.push("briefing_query: " + (e instanceof Error ? e.message : String(e)));
    }

    // 2. Compile intelligence summary for the brain
    const intelligenceSummary = [
        "=== TOP NEWS ===",
        ...recentNews.map(
            (n) => "[Score: " + n.score + "] " + n.title + "\n" + (n.summary || "")
        ),
        "\n=== LINKEDIN HIGHLIGHTS ===",
        ...recentPosts
            .slice(0, 10)
            .map(
                (p) => "[Engagement: " + p.engagement + "] " + (p.content?.slice(0, 200) || "")
            ),
        "\n=== BRIEFING INSIGHTS ===",
        ...recentBriefings.map((b) => b.content?.slice(0, 500) || ""),
    ].join("\n");

    // 3. Ask brain to select topic and generate content
    let selectedTopic = "AI transforming insurance in LATAM";
    let selectedFormat = "image_post";

    try {
        const topicSelection = await complete({
            role: "brain",
            system: CONTENT_SYSTEM,
            prompt: "Based on the following 24h intelligence, select THE SINGLE MOST impactful topic for a LinkedIn publication today. Consider what will generate the most engagement and establish thought leadership.\n\n" + intelligenceSummary + "\n\nFirst, decide the optimal format:\n- \"image_post\": A powerful text post with a supporting editorial image (most common)\n- \"article\": A long-form analysis piece\n- \"carousel\": Multiple insights that need visual structure\n\nRespond in JSON: {\"topic\": \"<selected topic>\", \"format\": \"<format>\", \"reasoning\": \"<why this topic today>\"}",
            temperature: 0.8,
            maxTokens: 500,
            jsonMode: true,
        });

        const topicParsed = safeJsonParse<{
            topic: string;
            format: string;
            reasoning: string;
        }>(topicSelection.content);

        if (topicParsed?.topic) selectedTopic = topicParsed.topic;
        if (topicParsed?.format) selectedFormat = topicParsed.format;
    } catch (e) {
        errors.push("topic_selection: " + (e instanceof Error ? e.message : String(e)));
    }

    // 4. Generate the full publication
    let content: ContentResult | null = null;
    try {
        const contentResult = await complete({
            role: "brain",
            system: CONTENT_SYSTEM,
            prompt: CONTENT_PROMPT(selectedTopic, intelligenceSummary, selectedFormat),
            temperature: 0.85,
            maxTokens: 4096,
            jsonMode: true,
        });

        content = safeJsonParse<ContentResult>(contentResult.content);
    } catch (e) {
        errors.push("content_generation: " + (e instanceof Error ? e.message : String(e)));
    }

    if (!content) {
        const errMsg = "Failed to generate content. Errors: " + errors.join("; ");
        try {
            await sendEmbed(
                CHANNELS.LOGS,
                createLogEmbed("generate-content", "error", errMsg, Date.now() - startTime)
            );
        } catch (_) { /* ignore */ }
        return NextResponse.json({ error: errMsg, errors }, { status: 500 });
    }

    // 5. Generate editorial image
    let imageUrl: string | undefined;
    if (content.imagePrompt) {
        try {
            const imageResult = await generateImage(content.imagePrompt);
            imageUrl = imageResult.imageUrl;
        } catch (imgError) {
            errors.push("image_gen: " + (imgError instanceof Error ? imgError.message : String(imgError)));
        }
    }

    // 6. Store publication in DB
    let publicationId = "unknown";
    try {
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
        publicationId = publication.id;
    } catch (e) {
        errors.push("db_insert: " + (e instanceof Error ? e.message : String(e)));
    }

    // 7. Send to Discord #daily-publication with approval buttons
    try {
        const { embed, buttons } = createPublicationEmbed({
            id: publicationId,
            title: content.title,
            content: content.content,
            format: content.format || selectedFormat,
            imageUrl,
            hookVariants: content.hookVariants,
        });
        await sendEmbed(CHANNELS.CONTENT, embed, [buttons]);
    } catch (e) {
        errors.push("discord_publication: " + (e instanceof Error ? e.message : String(e)));
    }

    // 8. Log success to Discord
    const duration = Date.now() - startTime;
    try {
        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed(
                "generate-content",
                errors.length === 0 ? "success" : "running",
                "Publicacion: " + content.title + "\nFormato: " + (content.format || selectedFormat) + "\nTema: " + selectedTopic + (imageUrl ? "\nCon imagen" : "\nSin imagen") + (errors.length > 0 ? "\nWarnings: " + errors.join(", ") : ""),
                duration
            )
        );
    } catch (_) { /* ignore */ }

    return NextResponse.json({
        success: true,
        publicationId,
        topic: selectedTopic,
        format: selectedFormat,
        hasImage: !!imageUrl,
        durationMs: duration,
        warnings: errors.length > 0 ? errors : undefined,
    });
}
