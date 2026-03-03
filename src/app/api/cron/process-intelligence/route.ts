import { NextResponse } from "next/server";
import { db } from "@/db";
import {
    newsItems,
    linkedinPosts,
    linkedinProfiles,
    intelligenceBriefings,
    commentSuggestions,
    pipelineRuns,
} from "@/db/schema";
import { complete } from "@/services/openrouter";
import { sendEmbed, createLogEmbed, CHANNELS } from "@/services/discord";
import { generateCycleId, COMMENT_TONES } from "@/config";
import { BRIEFING_SYSTEM, BRIEFING_PROMPT, COMMENT_SYSTEM, COMMENT_PROMPT } from "@/prompts";
import { safeJsonParse, type BriefingResult, type CommentResult } from "@/lib/types";
import { eq, and, sql, desc } from "drizzle-orm";

export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cycleId = generateCycleId();
    const startTime = Date.now();

    try {
        await db.insert(pipelineRuns).values({
            cycleId,
            phase: "process-intelligence",
            status: "running",
            startedAt: new Date(),
        });

        // 1. Get unprocessed news items
        const news = await db
            .select()
            .from(newsItems)
            .where(eq(newsItems.processed, false))
            .orderBy(desc(newsItems.score))
            .limit(30);

        // 2. Get unprocessed LinkedIn posts with profile info
        const posts = await db
            .select({
                post: linkedinPosts,
                profile: linkedinProfiles,
            })
            .from(linkedinPosts)
            .leftJoin(linkedinProfiles, eq(linkedinPosts.profileId, linkedinProfiles.id))
            .where(eq(linkedinPosts.processed, false))
            .orderBy(desc(linkedinPosts.engagement))
            .limit(30);

        if (news.length === 0 && posts.length === 0) {
            await sendEmbed(
                CHANNELS.LOGS,
                createLogEmbed("process-intelligence", "success", "No hay datos nuevos para procesar.", Date.now() - startTime)
            );
            return NextResponse.json({ success: true, message: "No new data" });
        }

        // 3. Generate Intelligence Briefing (Brain model)
        const newsForBriefing = news.map((n) => ({
            title: n.title,
            summary: n.summary || "",
            score: n.score || 0,
            source: n.source,
        }));

        const postsForBriefing = posts.map((p) => ({
            author: p.profile?.name || "Unknown",
            content: p.post.content || "",
            engagement: p.post.engagement || 0,
            type: p.profile?.type || "unknown",
        }));

        const briefingResult = await complete({
            role: "brain",
            system: BRIEFING_SYSTEM,
            prompt: BRIEFING_PROMPT(newsForBriefing, postsForBriefing),
            temperature: 0.7,
            maxTokens: 4096,
            jsonMode: true,
        });

        const briefing = safeJsonParse<BriefingResult>(briefingResult.content);

        if (!briefing) {
            throw new Error("Failed to parse briefing result");
        }

        // 4. Store briefing
        const [insertedBriefing] = await db
            .insert(intelligenceBriefings)
            .values({
                cycleId,
                content: briefing.fullBriefing,
                topInsights: briefing.topInsights,
                opportunities: briefing.opportunities,
                competitorAlerts: briefing.competitorAlerts,
                newsCount: news.length,
                linkedinPostsCount: posts.length,
            })
            .returning();

        // 5. Generate strategic comments for top posts
        const topPosts = posts
            .filter((p) => (p.post.engagement || 0) > 20)
            .slice(0, 5);

        for (const { post, profile } of topPosts) {
            if (!profile || !post.content) continue;

            const toneConfig =
                COMMENT_TONES[profile.type as keyof typeof COMMENT_TONES] ||
                COMMENT_TONES.ally;

            const commentResult = await complete({
                role: "brain",
                system: COMMENT_SYSTEM,
                prompt: COMMENT_PROMPT(
                    post.content,
                    profile.name,
                    profile.type,
                    toneConfig.instruction
                ),
                temperature: 0.8,
                maxTokens: 500,
                jsonMode: true,
            });

            const parsed = safeJsonParse<CommentResult>(commentResult.content);

            if (parsed) {
                await db.insert(commentSuggestions).values({
                    briefingId: insertedBriefing.id,
                    targetPostUrl: post.postUrl,
                    targetProfileName: profile.name,
                    relationshipType: profile.type,
                    comment: parsed.comment,
                    tone: parsed.tone || toneConfig.tone,
                });
            }
        }

        // 6. Mark items as processed
        for (const n of news) {
            await db
                .update(newsItems)
                .set({ processed: true })
                .where(eq(newsItems.id, n.id));
        }
        for (const { post } of posts) {
            await db
                .update(linkedinPosts)
                .set({ processed: true })
                .where(eq(linkedinPosts.id, post.id));
        }

        const duration = Date.now() - startTime;

        await db.insert(pipelineRuns).values({
            cycleId,
            phase: "process-intelligence",
            status: "success",
            itemsProcessed: news.length + posts.length,
            tokensUsed:
                briefingResult.tokensUsed.input + briefingResult.tokensUsed.output,
            duration,
            startedAt: new Date(startTime),
            completedAt: new Date(),
        });

        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed(
                "process-intelligence",
                "success",
                `Briefing generado: **${briefing.topInsights.length}** insights, **${briefing.opportunities.length}** oportunidades, **${topPosts.length}** comentarios estratégicos`,
                duration
            )
        );

        return NextResponse.json({
            success: true,
            cycleId,
            briefingId: insertedBriefing.id,
            insights: briefing.topInsights.length,
            opportunities: briefing.opportunities.length,
            comments: topPosts.length,
            durationMs: duration,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[Process Intelligence] Error:", errMsg);

        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed("process-intelligence", "error", `Error: ${errMsg}`, Date.now() - startTime)
        );

        return NextResponse.json({ error: errMsg }, { status: 500 });
    }
}
