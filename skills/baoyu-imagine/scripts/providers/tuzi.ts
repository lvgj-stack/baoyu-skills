import path from "node:path";
import { readFile } from "node:fs/promises";
import type { CliArgs } from "../types";

type TuziImageResponse = {
  data?: Array<{ url?: string; b64_json?: string }>;
  choices?: Array<{
    message?: {
      content?: Array<{
        type?: string;
        text?: string;
        image_url?: { url?: string | null } | string | null;
      }> | string | null;
    };
  }>;
};

type TuziVideoResponse = {
  data?: Array<{ url?: string }>;
  choices?: Array<{
    message?: {
      content?:
        | Array<{
            type?: string;
            text?: string;
            video_url?: { url?: string | null } | string | null;
          }>
        | string
        | null;
    };
  }>;
};

function getApiKey(): string | null {
  return process.env.TUZI_API_KEY || null;
}

function getBaseUrl(): string {
  return (process.env.TUZI_BASE_URL || "https://api.tu-zi.com/v1").replace(/\/+$/g, "");
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

async function readImageAsDataUrl(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return `data:${getMimeType(filePath)};base64,${bytes.toString("base64")}`;
}

function getHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function looksLikeOpenRouterStyleModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes("/") || normalized.startsWith("openrouter");
}

function shouldUseChatCompletionsForImage(model: string, args: CliArgs): boolean {
  return args.referenceImages.length > 0 || looksLikeOpenRouterStyleModel(model);
}

export function getDefaultModel(): string {
  return process.env.TUZI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";
}

export function getDefaultVideoModel(): string {
  return process.env.TUZI_VIDEO_MODEL || "openrouter/google/veo-3";
}

export function buildTuziImageRequestBody(
  prompt: string,
  model: string,
  args: CliArgs,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    prompt,
  };

  if (args.size) body.size = args.size;
  if (args.n > 1) body.n = args.n;

  return body;
}

export function buildTuziVideoRequestBody(
  prompt: string,
  model: string,
  args: CliArgs,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];

  for (const ref of args.referenceImages) {
    content.push({
      type: "image_url",
      image_url: { url: ref },
    });
  }

  const body: Record<string, unknown> = {
    model,
    modalities: ["video"],
    messages: [
      {
        role: "user",
        content,
      },
    ],
    stream: false,
  };

  if (args.duration) body.duration = args.duration;
  if (args.fps) body.fps = args.fps;

  return body;
}

function buildTuziImageChatBody(
  prompt: string,
  model: string,
  referenceImages: string[],
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];

  for (const ref of referenceImages) {
    content.push({
      type: "image_url",
      image_url: { url: ref },
    });
  }

  return {
    model,
    modalities: ["image", "text"],
    messages: [
      {
        role: "user",
        content,
      },
    ],
    stream: false,
  };
}

async function downloadBinary(url: string, label: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function decodeInlineDataUrl(value: string): Uint8Array | null {
  const match = value.match(/^data:[^;]+;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  return Uint8Array.from(Buffer.from(match[1]!, "base64"));
}

function extractImageUrl(item: { image_url?: { url?: string | null } | string | null }): string | null {
  const value = item.image_url;
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.url ?? null;
}

export async function extractImageFromResponse(result: TuziImageResponse): Promise<Uint8Array> {
  const image = result.data?.[0];
  if (image?.b64_json) {
    return Uint8Array.from(Buffer.from(image.b64_json, "base64"));
  }

  if (image?.url) {
    return downloadBinary(image.url, "Tuzi image");
  }

  const content = result.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const imageUrl = extractImageUrl(item);
      if (imageUrl) {
        return downloadBinary(imageUrl, "Tuzi image");
      }
      if (item.type === "text" && item.text) {
        const inline = decodeInlineDataUrl(item.text);
        if (inline) return inline;
      }
    }
  } else if (typeof content === "string") {
    const inline = decodeInlineDataUrl(content);
    if (inline) return inline;
  }

  throw new Error("No image in response");
}

export function extractVideoUrlFromResponse(result: TuziVideoResponse): string {
  const direct = result.data?.[0]?.url;
  if (direct) return direct;

  const content = result.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const value = item.video_url;
      if (!value) continue;
      if (typeof value === "string") return value;
      if (value.url) return value.url;
    }
  } else if (typeof content === "string" && /^https?:\/\//.test(content)) {
    return content;
  }

  throw new Error("No video in response");
}

export async function generateImage(
  prompt: string,
  model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("TUZI_API_KEY is required.");
  }

  const useChatCompletions = shouldUseChatCompletionsForImage(model, args);
  const referenceImages: string[] = [];
  for (const refPath of args.referenceImages) {
    referenceImages.push(await readImageAsDataUrl(refPath));
  }

  const endpoint = useChatCompletions ? `${getBaseUrl()}/chat/completions` : `${getBaseUrl()}/images/generations`;
  const body = useChatCompletions
    ? buildTuziImageChatBody(prompt, model, referenceImages)
    : buildTuziImageRequestBody(prompt, model, args);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tuzi API error (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as TuziImageResponse;
  return extractImageFromResponse(result);
}

export async function generateVideo(
  prompt: string,
  model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("TUZI_API_KEY is required.");
  }

  const referenceImages: string[] = [];
  for (const refPath of args.referenceImages) {
    if (refPath.startsWith("data:")) {
      referenceImages.push(refPath);
    } else {
      referenceImages.push(await readImageAsDataUrl(refPath));
    }
  }

  const body = buildTuziVideoRequestBody(prompt, model, {
    ...args,
    referenceImages,
  });

  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tuzi video API error (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as TuziVideoResponse;
  const videoUrl = extractVideoUrlFromResponse(result);
  return downloadBinary(videoUrl, "Tuzi video");
}

export function getDefaultOutputExtension(_model: string, args: CliArgs): string {
  return args.videoPath ? ".mp4" : ".png";
}
