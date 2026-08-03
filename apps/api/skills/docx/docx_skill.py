#!/usr/bin/env python3
"""Create .docx documents from a JSON block list.

Named docx_skill.py rather than docx.py so it cannot shadow the python-docx
package it imports.
"""
import json
import sys
from collections import Counter

from docx import Document


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def add_table(document, block, index):
    rows = block.get("rows") or []
    if not rows:
        fail(f"block {index}: table needs at least one row")

    columns = max(len(r) for r in rows)
    table = document.add_table(rows=0, cols=columns)
    table.style = "Table Grid"

    for row in rows:
        cells = table.add_row().cells
        for position, value in enumerate(row):
            cells[position].text = "" if value is None else str(value)

    if block.get("header") and table.rows:
        for cell in table.rows[0].cells:
            for paragraph in cell.paragraphs:
                for run in paragraph.runs:
                    run.bold = True


def main():
    if len(sys.argv) < 2:
        fail('expected a JSON argument, e.g. {"path":"a.docx","blocks":[...]}')
    try:
        spec = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        fail(f"argument is not valid JSON: {e}")

    path = spec.get("path")
    if not path:
        fail('"path" is required, e.g. "report.docx"')

    document = Document()
    if spec.get("title"):
        document.add_heading(str(spec["title"]), level=0)

    counts = Counter()
    for index, block in enumerate(spec.get("blocks") or []):
        kind = block.get("type")
        counts[kind] += 1

        if kind == "heading":
            level = max(1, min(4, int(block.get("level") or 1)))
            document.add_heading(str(block.get("text") or ""), level=level)
        elif kind == "paragraph":
            document.add_paragraph(str(block.get("text") or ""))
        elif kind == "bullets":
            for item in block.get("items") or []:
                document.add_paragraph(str(item), style="List Bullet")
        elif kind == "table":
            add_table(document, block, index)
        elif kind == "pagebreak":
            document.add_page_break()
        else:
            fail(f'block {index}: unknown type "{kind}"')

    document.save(path)
    print(f"wrote {path}")
    if counts:
        print("  " + ", ".join(f"{n} {kind}" for kind, n in counts.items()))


if __name__ == "__main__":
    main()
