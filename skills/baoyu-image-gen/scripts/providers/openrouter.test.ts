import assert from "node:assert/strict";
import test from "node:test";

import type { CliArgs } from "../types.ts";
import {
  buildContent,
  buildRequestBody,
  extractImageFromResponse,
  getAspectRatio,
  getImageSize,
} from "./openrouter.ts";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    provider: null,
    model: null,
    aspectRatio: null,
    size: null,
    quality: null,
    imageSize: null,
    referenceImages: [],
    n: 1,
    batchFile: null,
    jobs: null,
    json: false,
    help: false,
    ...overrides,
  };
}

test("OpenRouter request body uses image_config and string content for text-only prompts", () => {
  const args = makeArgs({ aspectRatio: "16:9", quality: "2k" });
  const body = buildRequestBody("hello", args, []);

  assert.deepEqual(body.image_config, {
    image_size: "2K",
    aspect_ratio: "16:9",
  });
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content, "hello");
});

test("OpenRouter request body keeps multimodal array content when references are provided", () => {
  const content = buildContent("hello", ["data:image/png;base64,abc"]);
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: "text", text: "hello" });
  assert.deepEqual(content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,abc" },
  });
});

test("OpenRouter size and aspect helpers infer expected defaults", () => {
  assert.equal(getImageSize(makeArgs({ quality: "normal" })), "1K");
  assert.equal(getImageSize(makeArgs({ size: "2048x1024" })), "2K");
  assert.equal(getAspectRatio(makeArgs({ size: "2048x1024" })), "2:1");
});

test("OpenRouter response extraction supports inline image data and finish_reason errors", async () => {
  const bytes = await extractImageFromResponse({
    choices: [
      {
        message: {
          images: [
            {
              image_url: {
                url: `data:image/png;base64,${Buffer.from("hello").toString("base64")}`,
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(Buffer.from(bytes).toString("utf8"), "hello");

  await assert.rejects(
    () =>
      extractImageFromResponse({
        choices: [
          {
            finish_reason: "error",
            native_finish_reason: "MALFORMED_FUNCTION_CALL",
            message: { content: null },
          },
        ],
      }),
    /finish_reason=MALFORMED_FUNCTION_CALL/,
  );
});
