import { NextResponse } from "next/server";
import { db } from "@/db";
import { intelligenceBriefings, commentSuggestions, pipelineRuns } from "@/db/schema";
import {
    sendEmbed,
    createBriefingEmbed,
    createCommentEmbed,
    createAlertEmbed,
    createLogEmbed,
    CHANNELS,
} from "@/services/discord";
import { generateCycleId } from "@/config";
import { desc, eq } from "drizzle-orm";

export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cycleId = generateCycleId();
    const startTime = Date.now();

    try {
        // 1. Get latest undelivered briefing
        const [briefing] = await db
            .select()
            .from(intelligenceBriefings)
            .where(eq(intelligenceBriefings.deliveredToDiscord, false))
            .orderBy(desc(intelligenceBriefings.createdAt))
            .limit(1);

        if (!briefing) {
            return NextResponse.json({ success: true, message: "No briefing to deliver" });
        }

        // 2. Send main briefing to #daily-briefing
        const briefingEmbed = createBriefingEmbed({
            cycleId: briefing.cycleId,
            topInsights: (briefing.topInsights as { title: string; summary: string; impact: string }[]) || [],
            opportunities: (briefing.opportunities as { description: string; urgency: string }[]) || [],
            competitorAlerts: (briefing.competitorAlerts as { company: string; alert: string }[]) || [],
            newsCount: briefing.newsCount || 0,
            linkedinPostsCount: briefing.linkedinPostsCount || 0,
        });

        await sendEmbed(CHANNELS.BRIEFING, briefingEmbed);

        // 3. Send high-priority alerts to #alerts
        const alerts = (briefing.competitorAlerts as { company: string; alert: string }[]) || [];
        for (const alert of alerts) {
            await sendEmbed(
                CHANNELS.ALERTS,
                createAlertEmbed(alert.company, alert.alert, "high")
            );
        }

        // 4. Send comment suggestions to #comments-suggestions
        const comments = await db
            .select()
            .from(commentSuggestions)
            .where(eq(commentSuggestions.briefingId, briefing.id));

        for (const comment of comments) {
            const { embed, buttons } = createCommentEmbed({
                id: comment.id,
                targetProfile: comment.targetProfileName || "Unknown",
                targetPostUrl: comment.targetPostUrl || "#",
                relationshipType: comment.relationshipType || "ally",
                comment: comment.comment,
                tone: comment.tone || "diplomático",
            });
            await sendEmbed(CHANNELS.COMMENTS, embed, [buttons]);
        }

        // 5. Mark briefing as delivered
        await db
            .update(intelligenceBriefings)
            .set({ deliveredToDiscord: true })
            .where(eq(intelligenceBriefings.id, briefing.id));

        const duration = Date.now() - startTime;

        await db.insert(pipelineRuns).values({
            cycleId,
            phase: "deliver-briefing",
            status: "success",
            itemsProcessed: 1 + comments.length,
            duration,
            startedAt: new Date(startTime),
            completedAt: new Date(),
        });

        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed(
                "deliver-briefing",
                "success",
                `Briefing entregado + **${alerts.length}** alertas + **${comments.length}** comentarios sugeridos`,
                duration
            )
        );

        return NextResponse.json({
            success: true,
            briefingId: briefing.id,
            alertsSent: alerts.length,
            commentsSent: comments.length,
            durationMs: duration,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[Deliver Briefing] Error:", errMsg);

        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed("deliver-briefing", "error", `Error: ${errMsg}`, Date.now() - startTime)
        );

        return NextResponse.json({ error: errMsg }, { status: 500 });
    }
}
