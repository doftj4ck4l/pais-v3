---
name: xlsx
description: Create or read .xlsx spreadsheets. Use when the user wants a spreadsheet, an Excel file, a table exported to Excel, or wants to know what is inside an existing .xlsx. Pass a JSON argument describing the operation.
run: python3 $SKILL_DIR/xlsx.py
---

# xlsx

Create and read Excel workbooks with openpyxl. Files are written into the user's
workspace, which is the current directory, and become downloadable from the
console's Files panel.

## How to use

Pass a single JSON object as the query.

### Create a workbook

```json
{
  "op": "create",
  "path": "sales.xlsx",
  "sheets": [
    {
      "name": "Q1",
      "rows": [["Region", "Revenue"], ["North", 1200], ["South", 900]],
      "header": true
    }
  ]
}
```

`header: true` bolds and freezes the first row. Column widths are sized to the
content. Numbers stay numbers — do not pre-format them as strings.

### Read a workbook

```json
{ "op": "read", "path": "sales.xlsx", "maxRows": 50 }
```

Returns each sheet's dimensions and its first `maxRows` rows (default 50).

## Output

`create` reports the path and per-sheet row counts. `read` prints the sheets as
plain text. On bad input the error names the offending field.
