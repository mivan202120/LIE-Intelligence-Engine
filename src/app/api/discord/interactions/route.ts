import { NextResponse } from "next/server";
import { db } from "@/db";
import { dailyPublications, commentSuggestions } from "@/db/schema";
import { generateImage } from "@/services/openrouter";
import {
    sendEmbed,
    createPublicationEmbed,
    createLogEmbed,
    CHANNELS,
} from "@/services/discord";
import { eq } from "drizzle-orm";
import nacl from "tweetnacl";

// ─── Discord Signature Verification ─────────────────────────────────
function verifyDiscordSignature(
    body: string,
    signature: string,
    timestamp: string
): boolean {
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) return false;

    try {
        return nacl.sign.detached.verify(
            Buffer.from(timestamp + body),
            Buffer.from(signature, "hex"),
            Buffer.from(publicKey, "hex")
        );
    } catch {
        return false;
    }
}

// ─── Interaction Types ──────────────────────────────────────────────
const InteractionType = {
    PING: 1,
    APPLICATION_COMMAND: 2,
    MESSAGE_COMPONENT: 3,
} as const;

const InteractionResponseType = {
    PONG: 1,
    CHANNEL_MESSAGE_WITH_SOURCE: 4,
    DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
    DEFERRED_UPDATE_MESSAGE: 6,
    UPDATE_MESSAGE: 7,
} as const;

export async function POST(request: Request) {
    const body = await request.text();
    const signature = request.headers.get("x-signature-ed25519") || "";
    const timestamp = request.headers.get("x-signature-timestamp") || "";

    // Verify signature
    if (!verifyDiscordSignature(body, signature, timestamp)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const interaction = JSON.parse(body);

    // Handle PING (Discord verification)
    if (interaction.type === InteractionType.PING) {
        return NextResponse.json({ type: InteractionResponseType.PONG });
    }

    // Handle button interactions
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
        const customId: string = interaction.data?.custom_id || "";

        // ── Approve Publication ──
        if (customId.startsWith("approve_")) {
            const pubId = customId.replace("approve_", "");
            await db
                .update(dailyPublications)
                .set({ status: "approved", approvedAt: new Date() })
                .where(eq(dailyPublications.id, pubId));

            return NextResponse.json({
                type: InteractionResponseType.UPDATE_MESSAGE,
                data: {
                    content: "✅ **Publicación aprobada.** Lista para publicar en LinkedIn.",
                    embeds: interaction.message?.embeds || [],
                    components: [], // Remove buttons after action
                },
            });
        }

        // ── Reject Publication ──
        if (customId.startsWith("reject_")) {
            const pubId = customId.replace("reject_", "");
            await db
                .update(dailyPublications)
                .set({ status: "rejected" })
                .where(eq(dailyPublications.id, pubId));

            return NextResponse.json({
                type: InteractionResponseType.UPDATE_MESSAGE,
                data: {
                    content: "❌ **Publicación rechazada.** Se generará una nueva mañana.",
                    embeds: interaction.message?.embeds || [],
                    components: [],
                },
            });
        }

        // ── Edit Publication ──
        if (customId.startsWith("edit_")) {
            const pubId = customId.replace("edit_", "");

            return NextResponse.json({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    content: `✏️ Para editar la publicación \`${pubId}\`, responde en este hilo con el texto corregido. El sistema actualizará el contenido.`,
                    flags: 64, // Ephemeral
                },
            });
        }

        // ── Regenerate Image ──
        if (customId.startsWith("regen_image_")) {
            const pubId = customId.replace("regen_image_", "");

            // Defer the response since image generation takes time
            // Note: In a full implementation, we'd use a deferred response + followup
            const [publication] = await db
                .select()
                .from(dailyPublications)
                .where(eq(dailyPublications.id, pubId))
                .limit(1);

            if (publication?.imagePrompt) {
                try {
                    const imageResult = await generateImage(publication.imagePrompt);

                    await db
                        .update(dailyPublications)
                        .set({ imageUrl: imageResult.imageUrl })
                        .where(eq(dailyPublications.id, pubId));

                    // Re-send publication with new image
                    const { embed, buttons } = createPublicationEmbed({
                        id: publication.id,
                        title: publication.title || "Publicación Diaria",
                        content: publication.content,
                        format: publication.format || "image_post",
                        imageUrl: imageResult.imageUrl,
                        hookVariants: publication.hookVariants as string[] | undefined,
                    });

                    await sendEmbed(CHANNELS.CONTENT, embed, [buttons]);

                    return NextResponse.json({
                        type: InteractionResponseType.UPDATE_MESSAGE,
                        data: {
                            content: "🎨 **Nueva imagen generada.** Revisa el mensaje actualizado arriba.",
                            components: [],
                        },
                    });
                } catch {
                    return NextResponse.json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: {
                            content: "⚠️ Error generando nueva imagen. Intenta de nuevo.",
                            flags: 64,
                        },
                    });
                }
            }
        }

        // ── Use Comment ──
        if (customId.startsWith("use_comment_")) {
            const commentId = customId.replace("use_comment_", "");
            await db
                .update(commentSuggestions)
                .set({ status: "approved" })
                .where(eq(commentSuggestions.id, commentId));

            return NextResponse.json({
                type: InteractionResponseType.UPDATE_MESSAGE,
                data: {
                    content: "✅ **Comentario marcado como usado.**",
                    embeds: interaction.message?.embeds || [],
                    components: [],
                },
            });
        }

        // ── Regenerate Comment ──
        if (customId.startsWith("regen_comment_")) {
            return NextResponse.json({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: {
                    content: "🔄 La regeneración de comentarios estará disponible pronto.",
                    flags: 64,
                },
            });
        }
    }

    // Default response for unhandled interactions
    return NextResponse.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
            content: "Interacción no reconocida.",
            flags: 64,
        },
    });
}
