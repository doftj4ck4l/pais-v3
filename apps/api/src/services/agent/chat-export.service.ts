import fontkit from "@pdf-lib/fontkit";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { fileURLToPath } from "node:url";
import { writeWorkspaceFile } from "../media/workspace-io";
import { workspaceFileUrl } from "../media/workspace-url";

export type ChatExportFormat = "pdf" | "docx";

type Block = {
  text: string;
  kind: "body" | "heading" | "bullet" | "code";
  level?: number;
};

export function requestedChatExport(message: string): ChatExportFormat | null {
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
  const action = /\b(export|save|download|make|create|convert|turn|buat|jadikan|simpan)\b/;
  const refersBack = /\b(this|that|above|answer|response|summary|analysis|ini|tadi|atas)\b/;
  if (!action.test(normalized) || !refersBack.test(normalized)) return null;
  if (/\b(docx|word(?: document)?)\b/.test(normalized)) return "docx";
  if (/\bpdf(?: document)?\b/.test(normalized)) return "pdf";
  return null;
}

/** Export one existing assistant answer without asking a model to rewrite it. */
export async function exportChatAnswer(input: {
  workspaceId: string;
  content: string;
  format: ChatExportFormat;
  now?: Date;
  write?: typeof writeWorkspaceFile;
  urlFor?: typeof workspaceFileUrl;
}): Promise<{ path: string; url: string; bytes: number }> {
  const now = input.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = `chat-export-${stamp}.${input.format}`;
  const bytes =
    input.format === "docx"
      ? await renderDocx(input.content)
      : await renderPdf(input.content, now);
  await (input.write ?? writeWorkspaceFile)(input.workspaceId, path, bytes);
  return {
    path,
    url: (input.urlFor ?? workspaceFileUrl)(input.workspaceId, path),
    bytes: bytes.byteLength,
  };
}

async function renderDocx(markdown: string): Promise<Uint8Array> {
  const blocks = markdownBlocks(markdown);
  const children = blocks.map((block) => {
    const text = new TextRun({
      text: block.kind === "bullet" ? `• ${block.text}` : block.text || " ",
      font: "Noto Sans",
      bold: block.kind === "heading",
      size: block.kind === "heading" ? Math.max(24, 36 - (block.level ?? 1) * 2) : 22,
    });
    return new Paragraph({
      children: [text],
      heading:
        block.kind === "heading"
          ? ([HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
              Math.min(2, Math.max(0, (block.level ?? 1) - 1))
            ] ?? HeadingLevel.HEADING_3)
          : undefined,
      spacing: { after: block.kind === "heading" ? 180 : 100, line: 300 },
      style: block.kind === "code" ? "PixelspaceCode" : undefined,
    });
  });
  const document = new Document({
    styles: {
      paragraphStyles: [
        {
          id: "PixelspaceCode",
          name: "Pixelspace code",
          basedOn: "Normal",
          next: "Normal",
          run: { font: "Courier New", size: 19 },
          paragraph: { spacing: { before: 80, after: 80 } },
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

async function renderPdf(markdown: string, createdAt: Date): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    Bun.file(fontPath("noto-sans-latin-ext-400-normal.woff")).arrayBuffer(),
    Bun.file(fontPath("noto-sans-latin-ext-700-normal.woff")).arrayBuffer(),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  pdf.setTitle("Pixelspace Chat export");
  pdf.setCreator("Pixelspace");
  pdf.setCreationDate(createdAt);

  const state = { page: pdf.addPage([595.28, 841.89]), y: 787 };
  for (const block of markdownBlocks(markdown)) {
    const font = block.kind === "heading" ? bold : regular;
    const size = block.kind === "heading" ? Math.max(14, 20 - (block.level ?? 1) * 2) : 10.5;
    const prefix = block.kind === "bullet" ? "• " : "";
    const lines = wrapText(prefix + (block.text || " "), font, size, 487);
    const lineHeight = size * 1.48;
    const before = block.kind === "heading" ? 8 : 0;
    state.y -= before;
    for (const line of lines) {
      ensurePdfSpace(pdf, state, lineHeight + 8);
      state.page.drawText(line, {
        x: block.kind === "bullet" ? 64 : 54,
        y: state.y,
        size,
        font,
        color: rgb(0.1, 0.11, 0.13),
      });
      state.y -= lineHeight;
    }
    state.y -= block.kind === "heading" ? 5 : 3;
  }
  return pdf.save();
}

function ensurePdfSpace(
  pdf: PDFDocument,
  state: { page: PDFPage; y: number },
  needed: number,
): void {
  if (state.y - needed >= 48) return;
  state.page = pdf.addPage([595.28, 841.89]);
  state.y = 787;
}

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  if (!text) return [" "];
  const words = text.replace(/\t/g, "    ").split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    if (font.widthOfTextAtSize(word, size) <= width) {
      line = word;
      continue;
    }
    let part = "";
    for (const character of [...word]) {
      const next = part + character;
      if (part && font.widthOfTextAtSize(next, size) > width) {
        lines.push(part);
        part = character;
      } else {
        part = next;
      }
    }
    line = part;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [" "];
}

function markdownBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let inCode = false;
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      blocks.push({ kind: "code", text: raw });
      continue;
    }
    const heading = raw.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: inlineText(heading[2]!) });
      continue;
    }
    const bullet = raw.match(/^\s*(?:[-*+] |\d+[.)]\s+)(.*)$/);
    if (bullet) {
      blocks.push({ kind: "bullet", text: inlineText(bullet[1]!) });
      continue;
    }
    blocks.push({ kind: "body", text: inlineText(raw) });
  }
  return blocks;
}

function inlineText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/`([^`]+)`/g, "$1");
}

function fontPath(file: string): string {
  return fileURLToPath(import.meta.resolve(`@fontsource/noto-sans/files/${file}`));
}

export const chatExportInternals = { markdownBlocks, inlineText, wrapText };
