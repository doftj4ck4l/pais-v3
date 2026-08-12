import { env } from "../../config/env";
import { generateImage } from "./image.service";

/**
 * The `generate_image` tool, bound to one workspace.
 *
 * The result text is deliberately tiny — an id, a markdown link, and the size.
 * The image itself is in the bucket. Returning the base64 would put 30k+
 * characters into the transcript, blow `RESULT_CHAR_CAP`, and then be replayed
 * to the model on every subsequent turn of the conversation for no benefit,
 * since the models we chat with cannot see images anyway.
 *
 * The instruction to embed the markdown link matters: the console renders
 * assistant text through `marked`, so `![alt](/api/images/id)` is what actually
 * puts the picture in front of the user. Without it the model tends to write
 * "I've generated the image" and show nothing.
 */
export function createImageTools(workspaceId: string, conversationId?: string): any[] {
  return [
    {
      name: "generate_image",
      label: "generate_image",
      description:
        "Generate an image from a text description, using Google Gemini via OpenRouter. " +
        "Use this whenever the user asks for a picture, illustration, logo, diagram, mockup or any visual. " +
        "Write a detailed, concrete prompt — subject, composition, style, lighting, colours — rather than " +
        "passing the user's words through unchanged; the description is the only control you have. " +
        "Returns a URL. You MUST embed that URL in your reply as markdown, e.g. ![a red fox](/api/images/abc), " +
        "or the user will not see the image. " +
        "Each call costs real money, so do not generate variations unless asked.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "detailed description of the image to make, e.g. 'a red fox asleep on a mossy log, " +
              "soft morning light, shallow depth of field, photographic'",
          },
          model: {
            type: "string",
            description:
              `optional OpenRouter image model slug. Defaults to ${env.imageModel}. ` +
              "Use google/gemini-3-pro-image only when the user asks for the best possible quality — " +
              "it costs roughly 4x the default.",
          },
        },
        required: ["prompt"],
      },
      async execute(_id: string, params: any) {
        const prompt = String(params?.prompt ?? "").trim();
        if (!prompt) return text("error: prompt required");

        const result = await generateImage({
          workspaceId,
          conversationId,
          prompt,
          model: params?.model ? String(params.model) : undefined,
        });

        if (!result.ok) return text(`error: ${result.error}`);

        const body = result.images
          .map((img) => {
            const kb = (img.bytes / 1024).toFixed(0);
            const cost =
              img.costMicros != null ? `, cost $${(img.costMicros / 1e6).toFixed(4)}` : "";
            return `![${prompt.slice(0, 80)}](${img.url})\n(id ${img.id}, ${img.contentType}, ${kb}KB${cost})`;
          })
          .join("\n\n");

        return text(
          `generated ${result.images.length} image(s) with ${result.images[0].model}:\n\n${body}\n\n` +
            `Include the markdown image line above verbatim in your reply so the user can see it.`,
        );
      },
    },
  ];
}

function text(out: string) {
  return { content: [{ type: "text" as const, text: out }], details: { output: out } };
}
