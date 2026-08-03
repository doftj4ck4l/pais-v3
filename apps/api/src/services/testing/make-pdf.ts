/**
 * Build a real, minimal PDF in memory — one page per string, with correct xref
 * offsets so a genuine parser accepts it.
 *
 * Test fixtures for extraction have to be actual PDFs. A stubbed parser would
 * only prove that the stub returns what it was told to, and the failures worth
 * catching here (page ordering, an absent text layer) live in the real one.
 */
export function makePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const pageCount = Math.max(1, pages.length);
  const pageIds = pages.map((_, i) => 4 + i * 2); // page obj, then its content obj

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  pages.forEach((text, i) => {
    const pageId = pageIds[i]!;
    const contentId = pageId + 1;
    // Escape the characters that terminate a PDF string literal.
    const safe = text.replace(/([\\()])/g, "\\$1");
    const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    const body = objects[id];
    if (!body) continue;
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  }

  const xrefStart = pdf.length;
  const maxId = objects.length;
  pdf += `xref\n0 ${maxId}\n0000000000 65535 f \n`;
  for (let id = 1; id < maxId; id++) {
    const off = offsets[id];
    pdf += off === undefined
      ? `0000000000 65535 f \n`
      : `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxId} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

/** A structurally valid PDF whose pages carry no text layer, like a scan. */
export function makeImageOnlyPdf(pageCount = 2): Uint8Array {
  return makePdf(Array(pageCount).fill(""));
}
