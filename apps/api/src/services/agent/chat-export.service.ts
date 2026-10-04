import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import { fileURLToPath } from "node:url";
import { writeWorkspaceFile } from "../media/workspace-io";
import { workspaceFileUrl } from "../media/workspace-url";

export type ChatExportFormat = "pdf" | "docx";

export type Block = {
  text: string;
  kind: "body" | "heading" | "bullet" | "code";
  level?: number;
};

export function requestedChatExport(message: string): ChatExportFormat | null {
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
  const action = /\b(export|save|download|make|create|convert|turn|buat|jadikan|simpan)\b/;
  if (!action.test(normalized)) return null;
  // Explanatory questions mention the same words but do not ask Pixelspace to
  // create a file. Requests such as "can you make this a PDF?" are still
  // allowed because they do not start with one of these how/what questions.
  if (/^(?:how (?:do|does|can|could|would)|what (?:is|are)|why|when|where)\b/.test(normalized)) {
    return null;
  }
  if (/\b(docx|word(?: document)?)\b/.test(normalized)) return "docx";
  if (/\bpdf(?: document)?\b/.test(normalized)) return "pdf";
  return null;
}

/** True when an export request clearly points at an earlier assistant answer. */
export function exportsPreviousAnswer(message: string): boolean {
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
  return /\b(this|that|above|answer|response|summary|analysis|ini|tadi|atas)\b/.test(normalized);
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
  return renderBrandedDocx({ blocks: markdownBlocks(markdown) });
}

/**
 * Render a branded DOCX from blocks: an optional title, then the blocks.
 *
 * Chat export and transcript export both go through here, so the two cannot
 * drift apart.
 */
export async function renderBrandedDocx(input: {
  blocks: Block[];
  title?: string;
}): Promise<Uint8Array> {
  const children = input.blocks.map(paragraphFor);
  if (input.title) {
    children.unshift(
      new Paragraph({
        children: [new TextRun({ text: input.title, bold: true, size: 32, font: "Helvetica" })],
        spacing: { after: 240 },
      }),
    );
  }
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

function paragraphFor(block: Block): Paragraph {
  const text = new TextRun({
    text: block.kind === "bullet" ? `• ${block.text}` : block.text || " ",
    font: "Helvetica",
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
}

// A4, with a logo band at the top of every page and a page-number footer.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 60;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const LOGO_WIDTH = 150;
const BODY_SIZE = 11;
const BODY_LINE_HEIGHT = BODY_SIZE * 1.5;
const TEXT_COLOR = rgb(0.1, 0.11, 0.13);
const MUTED_COLOR = rgb(0.45, 0.47, 0.5);
const RULE_COLOR = rgb(0.85, 0.86, 0.88);
const CODE_BACKGROUND = rgb(0.95, 0.96, 0.97);

type PdfFonts = { regular: PDFFont; bold: PDFFont; mono: PDFFont };
type PdfState = {
  pdf: PDFDocument;
  page: PDFPage;
  y: number;
  logo: PDFImage;
  fonts: PdfFonts;
  title?: string;
};

async function renderPdf(markdown: string, createdAt: Date): Promise<Uint8Array> {
  return renderBrandedPdf({ blocks: markdownBlocks(markdown), createdAt });
}

/**
 * Render a branded PDF: the Pixelspace logo on every page, an optional title
 * under it on the first page, then the blocks as the body.
 *
 * Chat export and transcript export both go through here, so the two cannot
 * drift apart.
 */
export async function renderBrandedPdf(input: {
  blocks: Block[];
  title?: string;
  createdAt?: Date;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  // Helvetica/Helvetica-Bold are the standard-14 metrics Arial was designed to
  // match, so they read as Arial without shipping a proprietary font. They are
  // WinAnsi-encoded, which is why pdfSafeText still downgrades unsupported
  // glyphs rather than letting drawText throw.
  const [regular, bold, mono] = await Promise.all([
    pdf.embedFont(StandardFonts.Helvetica),
    pdf.embedFont(StandardFonts.HelveticaBold),
    pdf.embedFont(StandardFonts.Courier),
  ]);
  assertPdfFontCoverage(regular);
  assertPdfFontCoverage(bold);
  const logo = await pdf.embedPng(await Bun.file(logoPath()).arrayBuffer());
  pdf.setTitle(input.title ? `Pixelspace — ${input.title}` : "Pixelspace Chat export");
  pdf.setCreator("Pixelspace");
  pdf.setCreationDate(input.createdAt ?? new Date());

  const state: PdfState = {
    pdf,
    page: pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: 0,
    logo,
    fonts: { regular, bold, mono },
    title: input.title,
  };
  state.y = drawHeader(state, true);

  for (const block of input.blocks) {
    if (block.kind === "heading") drawHeading(state, block);
    else if (block.kind === "bullet") drawBullet(state, block);
    else if (block.kind === "code") drawCode(state, block);
    else drawParagraph(state, block);
  }

  drawPageNumbers(pdf, regular);
  return pdf.save();
}

/**
 * Draws the logo band and returns the y where the first content line sits.
 *
 * `withTitle` is only true for the first page, so a title is not repeated on
 * every page while the logo is.
 */
function drawHeader(state: PdfState, withTitle: boolean): number {
  const logoHeight = (state.logo.height / state.logo.width) * LOGO_WIDTH;
  state.page.drawImage(state.logo, {
    x: MARGIN_X,
    y: PAGE_HEIGHT - MARGIN_TOP - logoHeight,
    width: LOGO_WIDTH,
    height: logoHeight,
  });
  const ruleY = PAGE_HEIGHT - MARGIN_TOP - logoHeight - 12;
  state.page.drawLine({
    start: { x: MARGIN_X, y: ruleY },
    end: { x: PAGE_WIDTH - MARGIN_X, y: ruleY },
    thickness: 0.75,
    color: RULE_COLOR,
  });
  let y = ruleY - 24;
  if (withTitle && state.title) {
    const size = 14;
    const lines = wrapText(pdfSafeText(state.title, state.fonts.bold), state.fonts.bold, size, CONTENT_WIDTH);
    for (const line of lines) {
      state.page.drawText(line, {
        x: MARGIN_X,
        y,
        size,
        font: state.fonts.bold,
        color: TEXT_COLOR,
      });
      y -= size * 1.4;
    }
    y -= 8;
  }
  return y;
}

function drawHeading(state: PdfState, block: Block): void {
  const level = block.level ?? 1;
  const size = headingSize(level);
  const font = state.fonts.bold;
  const text = level === 1 ? block.text.toUpperCase() : block.text;
  const lines = wrapText(pdfSafeText(text, font), font, size, CONTENT_WIDTH);
  const lineHeight = size * 1.4;
  state.y -= headingSpaceBefore(level);
  for (const line of lines) {
    ensurePdfSpace(state, lineHeight + 4);
    state.page.drawText(line, { x: MARGIN_X, y: state.y, size, font, color: TEXT_COLOR });
    if (level === 1) {
      state.page.drawLine({
        start: { x: MARGIN_X, y: state.y - 2.5 },
        end: { x: MARGIN_X + font.widthOfTextAtSize(line, size), y: state.y - 2.5 },
        thickness: 0.75,
        color: TEXT_COLOR,
      });
    }
    state.y -= lineHeight;
  }
  state.y -= headingSpaceAfter(level);
}

function drawParagraph(state: PdfState, block: Block): void {
  const font = state.fonts.regular;
  const lines = wrapText(pdfSafeText(block.text, font), font, BODY_SIZE, CONTENT_WIDTH);
  lines.forEach((line, index) => {
    ensurePdfSpace(state, BODY_LINE_HEIGHT + 2);
    drawJustifiedLine(state, line, MARGIN_X, CONTENT_WIDTH, font, index < lines.length - 1);
    state.y -= BODY_LINE_HEIGHT;
  });
  state.y -= 6;
}

function drawBullet(state: PdfState, block: Block): void {
  const font = state.fonts.regular;
  const indent = 18;
  const width = CONTENT_WIDTH - indent;
  const lines = wrapText(pdfSafeText(block.text, font), font, BODY_SIZE, width);
  lines.forEach((line, index) => {
    ensurePdfSpace(state, BODY_LINE_HEIGHT + 2);
    if (index === 0) {
      state.page.drawText("•", { x: MARGIN_X, y: state.y, size: BODY_SIZE, font, color: TEXT_COLOR });
    }
    drawJustifiedLine(state, line, MARGIN_X + indent, width, font, index < lines.length - 1);
    state.y -= BODY_LINE_HEIGHT;
  });
  state.y -= 4;
}

function drawCode(state: PdfState, block: Block): void {
  const font = state.fonts.mono;
  const size = 9.5;
  const lineHeight = size * 1.5;
  const padding = 6;
  const lines = wrapText(pdfSafeText(block.text || " ", font), font, size, CONTENT_WIDTH - padding * 2);
  for (const line of lines) {
    ensurePdfSpace(state, lineHeight + padding);
    state.page.drawRectangle({
      x: MARGIN_X,
      y: state.y + size * 0.8 - lineHeight,
      width: CONTENT_WIDTH,
      height: lineHeight,
      color: CODE_BACKGROUND,
    });
    state.page.drawText(line, {
      x: MARGIN_X + padding,
      y: state.y,
      size,
      font,
      color: TEXT_COLOR,
    });
    state.y -= lineHeight;
  }
  state.y -= 6;
}

/**
 * pdf-lib cannot justify text, so a line that is not the paragraph's last is
 * drawn word by word with the leftover width spread evenly between the words.
 */
function drawJustifiedLine(
  state: PdfState,
  text: string,
  x: number,
  width: number,
  font: PDFFont,
  justify: boolean,
): void {
  const words = text.split(" ").filter(Boolean);
  if (!justify || words.length < 2) {
    state.page.drawText(text || " ", { x, y: state.y, size: BODY_SIZE, font, color: TEXT_COLOR });
    return;
  }
  const natural = words.reduce((sum, word) => sum + font.widthOfTextAtSize(word, BODY_SIZE), 0);
  const gap = (width - natural) / (words.length - 1);
  if (gap <= font.widthOfTextAtSize(" ", BODY_SIZE)) {
    state.page.drawText(text, { x, y: state.y, size: BODY_SIZE, font, color: TEXT_COLOR });
    return;
  }
  let cursor = x;
  for (const word of words) {
    state.page.drawText(word, { x: cursor, y: state.y, size: BODY_SIZE, font, color: TEXT_COLOR });
    cursor += font.widthOfTextAtSize(word, BODY_SIZE) + gap;
  }
}

function headingSize(level: number): number {
  return level <= 2 ? 12 : 11;
}

function headingSpaceBefore(level: number): number {
  if (level === 1) return 16;
  if (level === 2) return 14;
  return 10;
}

function headingSpaceAfter(level: number): number {
  if (level === 1) return 8;
  if (level === 2) return 6;
  return 4;
}

function drawPageNumbers(pdf: PDFDocument, font: PDFFont): void {
  const pages = pdf.getPages();
  const size = 9;
  pages.forEach((page, index) => {
    const label = `${index + 1} / ${pages.length}`;
    page.drawText(label, {
      x: (PAGE_WIDTH - font.widthOfTextAtSize(label, size)) / 2,
      y: 30,
      size,
      font,
      color: MUTED_COLOR,
    });
  });
}

/**
 * The standard-14 fonts are WinAnsi-encoded, so anything outside that set has
 * no glyph and pdfSafeText downgrades it. Fail loudly if the assumed coverage
 * ever regresses, rather than emitting a PDF full of `.notdef` boxes.
 */
function assertPdfFontCoverage(font: PDFFont): void {
  const characters = new Set(font.getCharacterSet());
  for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 •—–‘’“”") {
    if (!characters.has(character.codePointAt(0)!)) {
      throw new Error("The PDF font does not cover ordinary chat text");
    }
  }
}

/** Avoid drawing a font's `.notdef` glyph, which PDF readers show as a box. */
function pdfSafeText(text: string, font: Pick<PDFFont, "getCharacterSet">): string {
  const characters = new Set(font.getCharacterSet());
  return [...text.normalize("NFC")]
    .map((character) => {
      if (characters.has(character.codePointAt(0)!)) return character;
      const readable = [...character.normalize("NFKD")]
        .filter((part) => characters.has(part.codePointAt(0)!))
        .join("");
      return readable || "?";
    })
    .join("");
}

function ensurePdfSpace(state: PdfState, needed: number): void {
  if (state.y - needed >= MARGIN_BOTTOM) return;
  state.page = state.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  state.y = drawHeader(state, false);
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
  let paragraph: string[] = [];
  // Soft-wrapped source lines are one paragraph, so they are merged here rather
  // than becoming separate blocks: justification has to know which line is the
  // paragraph's last.
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: "body", text: paragraph.join(" ") });
      paragraph = [];
    }
  };
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) {
      flush();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      blocks.push({ kind: "code", text: raw });
      continue;
    }
    const heading = raw.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: inlineText(heading[2]!) });
      continue;
    }
    const bullet = raw.match(/^\s*(?:[-*+] |\d+[.)]\s+)(.*)$/);
    if (bullet) {
      flush();
      blocks.push({ kind: "bullet", text: inlineText(bullet[1]!) });
      continue;
    }
    if (!raw.trim()) {
      flush();
      continue;
    }
    paragraph.push(inlineText(raw));
  }
  flush();
  return blocks;
}

function inlineText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/`([^`]+)`/g, "$1");
}

function logoPath(): string {
  return fileURLToPath(new URL("./assets/pixelspace.png", import.meta.url));
}

export const chatExportInternals = { markdownBlocks, inlineText, pdfSafeText, wrapText };
