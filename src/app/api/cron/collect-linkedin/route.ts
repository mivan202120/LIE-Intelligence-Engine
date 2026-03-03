import { NextResponse } from "next/server";
import { db } from "@/db";
import { linkedinProfiles, linkedinPosts, pipelineRuns } from "@/db/schema";
import { complete, embed } from "@/services/openrouter";
import { sendEmbed, createLogEmbed, CHANNELS } from "@/services/discord";
import { generateCycleId } from "@/config";
import { safeJsonParse } from "@/lib/types";
import { eq } from "drizzle-orm";

const APIFY_LINKEDIN_ACTOR = "curious_coder/linkedin-post-search-scraper";

interface ApifyLinkedinPost {
    text?: string;
    url?: string;
    numLikes?: number;
    numComments?: number;
    numShares?: number;
    authorName?: string;
    authorUrl?: string;
    postedAt?: string;
}

async function scrapeLinkedinPosts(profileUrls: string[]): Promise<ApifyLinkedinPost[]> {
    const token = process.env.APIFY_API_TOKEN;
    if (!token) throw new Error("Missing APIFY_API_TOKEN");

    try {
        // Start the Apify actor run
        const startRes = await fetch(
            `https://api.apify.com/v2/acts/${APIFY_LINKEDIN_ACTOR}/runs?token=${token}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    urls: profileUrls,
                    maxResults: 5, // Latest 5 posts per profile
                }),
            }
        );

        const runData = await startRes.json();
        const runId = runData.data?.id;
        if (!runId) throw new Error("Failed to start Apify run");

        // Wait for completion (poll every 5 seconds, max 3 minutes)
        let status = "RUNNING";
        let attempts = 0;
        while (status === "RUNNING" && attempts < 36) {
            await new Promise((r) => setTimeout(r, 5000));
            const statusRes = await fetch(
                `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`
            );
            const statusData = await statusRes.json();
            status = statusData.data?.status || "FAILED";
            attempts++;
        }

        if (status !== "SUCCEEDED") {
            throw new Error(`Apify run ${runId} ended with status: ${status}`);
        }

        // Fetch results
        const resultRes = await fetch(
            `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}`
        );
        return await resultRes.json();
    } catch (error) {
        console.error("[Apify] LinkedIn scraping failed:", error);
        return [];
    }
}

export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cycleId = generateCycleId();
    const startTime = Date.now();
    let itemsProcessed = 0;

    try {
        await db.insert(pipelineRuns).values({
            cycleId,
            phase: "collect-linkedin",
            status: "running",
            startedAt: new Date(),
        });

        // 1. Get active profiles
        const profiles = await db
            .select()
            .from(linkedinProfiles)
            .where(eq(linkedinProfiles.active, true));

        if (profiles.length === 0) {
            await sendEmbed(
                CHANNELS.LOGS,
                createLogEmbed("collect-linkedin", "success", "No hay perfiles activos para monitorear.", Date.now() - startTime)
            );
            return NextResponse.json({ success: true, message: "No active profiles" });
        }

        // 2. Scrape in batches of 10
        const profileUrls = profiles.map((p) => p.linkedinUrl);
        const batchSize = 10;

        for (let i = 0; i < profileUrls.length; i += batchSize) {
            const batch = profileUrls.slice(i, i + batchSize);
            const scrapedPosts = await scrapeLinkedinPosts(batch);

            for (const post of scrapedPosts) {
                if (!post.text) continue;

                // Find matching profile
                const profile = profiles.find((p) =>
                    post.authorUrl?.includes(p.linkedinUrl.split("/in/")[1]?.replace("/", ""))
                );

                // Generate embedding for the post
                const embResult = await embed(post.text.slice(0, 1000));

                // Quick analysis with muscle model
                const analysis = await complete({
                    role: "muscle",
                    prompt: `Analyze this LinkedIn post briefly. What is the key topic, sentiment (positive/negative/neutral), and any strategic signals?
          
Author: ${post.authorName || "Unknown"}
Post: ${post.text?.slice(0, 800)}

Respond in JSON: {"topics": ["topic1"], "sentiment": "positive|negative|neutral", "analysis": "brief analysis in Spanish"}`,
                    temperature: 0.3,
                    maxTokens: 300,
                    jsonMode: true,
                });

                const parsed = safeJsonParse<{
                    topics: string[];
                    sentiment: string;
                    analysis: string;
                }>(analysis.content);

                const totalEngagement = (post.numLikes || 0) + (post.numComments || 0) * 3 + (post.numShares || 0) * 5;

                await db.insert(linkedinPosts).values({
                    profileId: profile?.id,
                    postUrl: post.url,
                    content: post.text,
                    likes: post.numLikes || 0,
                    comments: post.numComments || 0,
                    shares: post.numShares || 0,
                    engagement: totalEngagement,
                    sentiment: parsed?.sentiment,
                    topics: parsed?.topics,
                    analysis: parsed?.analysis,
                    embedding: JSON.stringify(embResult.embedding),
                    processed: false,
                    cycleId,
                    postedAt: post.postedAt ? new Date(post.postedAt) : null,
                });

                // Update last scraped timestamp
                if (profile) {
                    await db
                        .update(linkedinProfiles)
                        .set({ lastScrapedAt: new Date() })
                        .where(eq(linkedinProfiles.id, profile.id));
                }

                itemsProcessed++;
            }
        }

        const duration = Date.now() - startTime;

        await db.insert(pipelineRuns).values({
            cycleId,
            phase: "collect-linkedin",
            status: "success",
            itemsProcessed,
            duration,
            startedAt: new Date(startTime),
            completedAt: new Date(),
        });

        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed(
                "collect-linkedin",
                "success",
                `Monitoreados **${profiles.length}** perfiles → **${itemsProcessed}** posts procesados`,
                duration
            )
        );

        return NextResponse.json({
            success: true,
            cycleId,
            profilesMonitored: profiles.length,
            postsProcessed: itemsProcessed,
            durationMs: duration,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[LinkedIn Collector] Error:", errMsg);

        await sendEmbed(
            CHANNELS.LOGS,
            createLogEmbed("collect-linkedin", "error", `Error: ${errMsg}`, Date.now() - startTime)
        );

        return NextResponse.json({ error: errMsg }, { status: 500 });
    }
}
