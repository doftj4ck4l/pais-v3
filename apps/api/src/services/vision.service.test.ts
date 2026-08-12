import { describe, expect, it } from "bun:test";
import { describeImage } from "./vision.service";

const bytes = new Uint8Array([137, 80, 78, 71]);
const base = { bytes, contentType: "image/png", question: "what does it say?" };
const creds = { apiKey: "k", baseUrl: "http://gw/v1" };

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("describeImage", () => {
  it("returns the model's text", async () => {
    const result = await describeImage(base, {
      ...creds,
      fetchImpl: (async () => reply("PIXELSPACE")) as any,
    });
    expect(result).toEqual({ ok: true, text: "PIXELSPACE", model: expect.any(String) });
  });

  it("sends the image as a data URI alongside the question", async () => {
    let body: any;
    await describeImage(base, {
      ...creds,
      fetchImpl: (async (_url: string, init: any) => {
        body = JSON.parse(init.body);
        return reply("ok");
      }) as any,
    });

    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "what does it say?" });
    expect(content[1].image_url.url).toStartWith("data:image/png;base64,");
    // No max_tokens: a reasoning model spends the same budget on reasoning as
    // on the answer, and a small cap returns length-stopped with empty content.
    expect(body.max_tokens).toBeUndefined();
  });

  it("uses the requested model over the default", async () => {
    let body: any;
    await describeImage(
      { ...base, model: "vrs_smart" },
      {
        ...creds,
        fetchImpl: (async (_u: string, init: any) => {
          body = JSON.parse(init.body);
          return reply("ok");
        }) as any,
      },
    );
    expect(body.model).toBe("vrs_smart");
  });

  it("surfaces the gateway's own refusal, which names the fix", async () => {
    // "X is not a multimodal model" tells you to change the model; "HTTP 400"
    // sends you looking at the image.
    const result = await describeImage(base, {
      ...creds,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: { message: "DeepSeek-V4-Flash-0731 is not a multimodal model" } }),
          { status: 400 },
        )) as any,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("not a multimodal model");
  });

  it("reports an empty answer rather than returning empty text", async () => {
    const result = await describeImage(base, {
      ...creds,
      fetchImpl: (async () => reply("   ")) as any,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("empty");
  });

  it("survives a non-JSON response", async () => {
    const result = await describeImage(base, {
      ...creds,
      fetchImpl: (async () => new Response("<html>502</html>", { status: 200 })) as any,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("not JSON");
  });

  it("survives the request throwing", async () => {
    const result = await describeImage(base, {
      ...creds,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as any,
    });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("ECONNREFUSED");
  });

  it("says so when nothing is configured", async () => {
    const result = await describeImage(base, { apiKey: "", baseUrl: "" });
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("no vision model is configured");
  });

  it("refuses an image past the size cap before spending a request", async () => {
    let called = false;
    const result = await describeImage(
      { ...base, bytes: new Uint8Array(20_000_000) },
      {
        ...creds,
        fetchImpl: (async () => {
          called = true;
          return reply("x");
        }) as any,
      },
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain("limit");
    expect(called).toBe(false);
  });
});
