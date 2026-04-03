import assert from "node:assert/strict";
import test from "node:test";

import type { CliArgs } from "../types.ts";
import {
  buildTuziImageRequestBody,
  buildTuziVideoRequestBody,
  extractImageFromResponse,
  extractVideoUrlFromResponse,
} from "./tuzi.ts";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    videoPath: null,
    provider: "tuzi",
    model: null,
    videoModel: null,
    aspectRatio: null,
    size: null,
    quality: null,
    imageSize: null,
    referenceImages: [],
    duration: null,
    fps: null,
    n: 1,
    batchFile: null,
    jobs: null,
    json: false,
    help: false,
    ...overrides,
  };
}

test("Tuzi image request body uses OpenAI-compatible images API shape", () => {
  const body = buildTuziImageRequestBody("draw a fox", "gpt-image-1", makeArgs({
    size: "1536x1024",
    n: 2,
  }));

  assert.deepEqual(body, {
    model: "gpt-image-1",
    prompt: "draw a fox",
    size: "1536x1024",
    n: 2,
  });
});

test("Tuzi video request body uses chat-completions style with optional reference image", () => {
  const body = buildTuziVideoRequestBody(
    "animate this still",
    "openrouter/google/veo-3",
    makeArgs({
      duration: 5,
      fps: 24,
      referenceImages: ["data:image/png;base64,Zm9v"],
    }),
  );

  assert.equal(body.model, "openrouter/google/veo-3");
  assert.deepEqual(body.modalities, ["video"]);
  assert.equal(body.duration, 5);
  assert.equal(body.fps, 24);
  assert.deepEqual(body.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "animate this still" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,Zm9v",
          },
        },
      ],
    },
  ]);
});

test("Tuzi image response extraction supports base64 and URL downloads", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const fromBase64 = await extractImageFromResponse({
    data: [{ b64_json: Buffer.from("hello").toString("base64") }],
  });
  assert.equal(Buffer.from(fromBase64).toString("utf8"), "hello");

  globalThis.fetch = async () =>
    new Response(Uint8Array.from([4, 5, 6]), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });

  const fromUrl = await extractImageFromResponse({
    data: [{ url: "https://example.com/image.png" }],
  });
  assert.deepEqual([...fromUrl], [4, 5, 6]);
});

test("Tuzi video response extraction supports direct video URLs and nested OpenRouter-style content", () => {
  assert.equal(
    extractVideoUrlFromResponse({
      data: [{ url: "https://example.com/demo.mp4" }],
    }),
    "https://example.com/demo.mp4",
  );

  assert.equal(
    extractVideoUrlFromResponse({
      choices: [
        {
          message: {
            content: [
              {
                type: "video_url",
                video_url: {
                  url: "https://example.com/openrouter.mp4",
                },
              },
            ],
          },
        },
      ],
    }),
    "https://example.com/openrouter.mp4",
  );

  assert.throws(
    () => extractVideoUrlFromResponse({ choices: [{ message: { content: [] } }] }),
    /No video in response/,
  );
});
