---
name: docx
description: Create .docx Word documents with headings, paragraphs, bullet lists and tables. Use when the user wants a Word document, a report, a letter or a formatted write-up. Pass a JSON argument describing the blocks.
usage: a JSON object; required "path" (e.g. "report.docx") and "blocks" (array of heading/paragraph/bullets/table/pagebreak); optional "title"
run: python3 $SKILL_DIR/docx_skill.py
---

# docx

Build Word documents with python-docx. Files are written into the user's
workspace, which is the current directory, and become downloadable from the
console's Files panel.

## How to use

Pass a single JSON object as the query.

```json
{
  "path": "report.docx",
  "title": "Quarterly Report",
  "blocks": [
    { "type": "heading", "text": "Summary", "level": 1 },
    { "type": "paragraph", "text": "Revenue grew 12% year on year." },
    { "type": "bullets", "items": ["North up 8%", "South flat"] },
    {
      "type": "table",
      "rows": [["Region", "Revenue"], ["North", "1200"]],
      "header": true
    }
  ]
}
```

Block types: `heading` (with `level` 1-4), `paragraph`, `bullets`, `table`,
`pagebreak`. `title` is optional and renders as the document title above
everything else.

## Output

Reports the path written and a count of each block type. On bad input the error
names the offending block index.

## Limits

Creation only — this does not edit an existing .docx, and cannot convert to PDF
(the sandbox image has no LibreOffice).
