import { REST } from "@discordjs/rest";
import {
    ActionRowBuilder,
    ButtonBuilder,
    EmbedBuilder,
} from "@discordjs/builders";
import { ButtonStyle } from "discord-api-types/v10";
import type { APIActionRowComponent, APIButtonComponent } from "discord-api-types/v10";

// ─── Webhook Execution (raw fetch, no gateway) ─────────────────────
function getWebhookUrl(channel: string): string {
    const envKey = `DISCORD_WEBHOOK_${channel.toUpperCase()}`;
    const url = process.env[envKey];
    if (!url) throw new Error(`Missing env var: ${envKey}`);
    return url;
}

async function executeWebhook(
    channel: string,
    payload: {
        content?: string;
        embeds?: ReturnType<EmbedBuilder["toJSON"]>[];
        components?: APIActionRowComponent<APIButtonComponent>[];
    }
) {
    const url = getWebhookUrl(channel);

    const res = await fetch(`${url}?wait=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Discord webhook failed (${res.status}): ${errorText}`);
    }

    return res.json();
}

// ─── Webhook with Image Attachment ──────────────────────────────────
async function executeWebhookWithImage(
    channel: string,
    imageBase64: string,
    mimeType: string,
    payload: {
        embeds?: ReturnType<EmbedBuilder["toJSON"]>[];
        components?: APIActionRowComponent<APIButtonComponent>[];
    }
) {
    const url = getWebhookUrl(channel);
    const ext = mimeType.includes("png") ? "png" : "jpg";
    const filename = `publication.${ext}`;

    // Convert base64 to binary
    const binaryString = atob(imageBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });

    const formData = new FormData();
    formData.append("file", blob, filename);
    formData.append("payload_json", JSON.stringify(payload));

    const res = await fetch(`${url}?wait=true`, {
        method: "POST",
        body: formData,
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Discord webhook with image failed (${res.status}): ${errorText}`);
    }

    return res.json();
}

// ─── Channel Names ──────────────────────────────────────────────────
export const CHANNELS = {
    BRIEFING: "briefing",
    ALERTS: "alerts",
    CONTENT: "content",
    NEWS: "news",
    LINKEDIN: "linkedin",
    COMMENTS: "comments",
    LOGS: "logs",
} as const;

type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

// ─── Send Embed ─────────────────────────────────────────────────────
export async function sendEmbed(
    channel: ChannelName,
    embed: EmbedBuilder,
    components?: ActionRowBuilder<ButtonBuilder>[],
    imageData?: string // "base64:mimeType:data" format from generateImage
) {
    const payload = {
        embeds: [embed.toJSON()],
        ...(components && {
            components: components.map((c) => c.toJSON() as APIActionRowComponent<APIButtonComponent>),
        }),
    };

    // If we have base64 image data, upload as attachment
    if (imageData && imageData.startsWith("base64:")) {
        const parts = imageData.split(":");
        const mimeType = parts[1];
        const base64 = parts.slice(2).join(":"); // rejoin in case of colons in base64

        // Set embed image to reference the attachment
        const embedJson = payload.embeds[0];
        const ext = mimeType.includes("png") ? "png" : "jpg";
        embedJson.image = { url: `attachment://publication.${ext}` };

        await executeWebhookWithImage(channel, base64, mimeType, payload);
    } else {
        await executeWebhook(channel, payload);
    }
}

// ─── Send Simple Message ────────────────────────────────────────────
export async function sendMessage(channel: ChannelName, content: string) {
    await executeWebhook(channel, { content });
}

// ─── Briefing Embed ─────────────────────────────────────────────────
export function createBriefingEmbed(data: {
    cycleId: string;
    topInsights: { title: string; summary: string; impact: string }[];
    opportunities: { description: string; urgency: string }[];
    competitorAlerts: { company: string; alert: string }[];
    newsCount: number;
    linkedinPostsCount: number;
}): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle("Intelligence Briefing - " + data.cycleId)
        .setColor(0x7c3aed)
        .setTimestamp()
        .setFooter({ text: "LIE Intelligence Engine" });

    if (data.topInsights.length > 0) {
        const insightsText = data.topInsights
            .slice(0, 5)
            .map((i, idx) => "**" + (idx + 1) + ". " + i.title + "**\n" + i.summary + "\n_Impacto: " + i.impact + "_")
            .join("\n\n");
        embed.addFields({ name: "Top Insights", value: insightsText.slice(0, 1024) });
    }

    if (data.opportunities.length > 0) {
        const oppsText = data.opportunities
            .slice(0, 3)
            .map((o) => "- " + o.description + " _(" + o.urgency + ")_")
            .join("\n");
        embed.addFields({ name: "Oportunidades", value: oppsText.slice(0, 1024) });
    }

    if (data.competitorAlerts.length > 0) {
        const alertsText = data.competitorAlerts
            .map((a) => "- **" + a.company + ":** " + a.alert)
            .join("\n");
        embed.addFields({ name: "Alertas Competidores", value: alertsText.slice(0, 1024) });
    }

    embed.addFields({
        name: "Stats",
        value: "Noticias: **" + data.newsCount + "** | LinkedIn: **" + data.linkedinPostsCount + "**",
    });

    return embed;
}

// ─── Publication Embed with Approval Buttons ────────────────────────
export function createPublicationEmbed(data: {
    id: string;
    title: string;
    content: string;
    format: string;
    imageUrl?: string;
    hookVariants?: string[];
}): { embed: EmbedBuilder; buttons: ActionRowBuilder<ButtonBuilder> } {
    const embed = new EmbedBuilder()
        .setTitle("Publicacion Diaria - " + data.title)
        .setColor(0x10b981)
        .setDescription(data.content.slice(0, 4096))
        .setFooter({ text: "Formato: " + data.format + " | ID: " + data.id })
        .setTimestamp();

    if (data.imageUrl) {
        embed.setImage(data.imageUrl);
    }

    if (data.hookVariants && data.hookVariants.length > 0) {
        const variantsText = data.hookVariants
            .map((v, i) => "**Variante " + (i + 1) + ":** " + v)
            .join("\n\n");
        embed.addFields({
            name: "Variantes de Hook",
            value: variantsText.slice(0, 1024),
        });
    }

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("approve_" + data.id)
            .setLabel("Aprobar")
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId("edit_" + data.id)
            .setLabel("Editar")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId("reject_" + data.id)
            .setLabel("Rechazar")
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId("regen_image_" + data.id)
            .setLabel("Nueva Imagen")
            .setStyle(ButtonStyle.Secondary)
    );

    return { embed, buttons };
}

// ─── Alert Embed ────────────────────────────────────────────────────
export function createAlertEmbed(
    title: string,
    description: string,
    urgency: "high" | "medium" | "low" = "high"
): EmbedBuilder {
    const colors = { high: 0xef4444, medium: 0xf59e0b, low: 0x3b82f6 };
    const icons = { high: "[ALERTA]", medium: "[AVISO]", low: "[INFO]" };

    return new EmbedBuilder()
        .setTitle(icons[urgency] + " " + title)
        .setDescription(description)
        .setColor(colors[urgency])
        .setTimestamp()
        .setFooter({ text: "LIE Intelligence Engine" });
}

// ─── Log Embed ──────────────────────────────────────────────────────
export function createLogEmbed(
    phase: string,
    status: "success" | "error" | "running",
    details: string,
    duration?: number
): EmbedBuilder {
    const colors = { success: 0x10b981, error: 0xef4444, running: 0xf59e0b };
    const icons = { success: "[OK]", error: "[ERROR]", running: "[RUNNING]" };

    const embed = new EmbedBuilder()
        .setTitle(icons[status] + " Pipeline: " + phase)
        .setDescription(details.slice(0, 4096))
        .setColor(colors[status])
        .setTimestamp()
        .setFooter({ text: "LIE Pipeline" });

    if (duration) {
        embed.addFields({
            name: "Duracion",
            value: (duration / 1000).toFixed(1) + "s",
            inline: true,
        });
    }

    return embed;
}

// ─── Comment Suggestion Embed ───────────────────────────────────────
export function createCommentEmbed(data: {
    id: string;
    targetProfile: string;
    targetPostUrl: string;
    relationshipType: string;
    comment: string;
    tone: string;
}): { embed: EmbedBuilder; buttons: ActionRowBuilder<ButtonBuilder> } {
    const embed = new EmbedBuilder()
        .setTitle("Comentario para " + data.targetProfile)
        .setColor(0x6366f1)
        .setDescription(data.comment)
        .addFields(
            { name: "Relacion", value: data.relationshipType, inline: true },
            { name: "Tono", value: data.tone, inline: true },
            { name: "Post", value: "[Ver post](" + data.targetPostUrl + ")", inline: true }
        )
        .setTimestamp();

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("use_comment_" + data.id)
            .setLabel("Usar")
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId("regen_comment_" + data.id)
            .setLabel("Regenerar")
            .setStyle(ButtonStyle.Secondary)
    );

    return { embed, buttons };
}
