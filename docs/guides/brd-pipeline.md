# Guide: build a docs → BRD pipeline on the canvas

This guide builds, by hand on the canvas, a Google ADK workflow that:

1. **Indexes `docs/`** when you send `start` in `adk web`. It deletes any old `manifest.json`, walks `docs/` and all of its subfolders, and sorts every file into **documents** (`.docx` via python-docx, plus any UTF-8 text such as `.md` or code), **tables** (`.csv`, `.tsv`, `.parquet` via duckdb) and **images** (summarised by Gemini). The result is written to `docs/manifest.json`.
2. **Writes a BRD in a loop.** A generator explores the manifest and the files behind it, then saves `brd.docx` with relevant images embedded. A critic investigates the sources itself, including running its own SQL against the tables, and either approves or sends the draft to a reviser.
3. **Saves `output/brd.docx`** with a disclaimer at the end:
   - **Approved:** the standard disclaimer.
   - **Not approved after 5 rounds:** the standard disclaimer, plus a note that it was not approved and the critic's latest issue.

```
START → scan_docs → index_documents → index_tables → index_images → write_manifest → brd_loop
```

You don't have to type it all: [`brd-pipeline.agentgraph.json`](brd-pipeline.agentgraph.json) is the finished graph. Use **Load IR** to open it, or to compare it with your own build.

## How the pieces talk to each other

Two facts about the builder shape this design:

- **A loop node does not take its upstream node's output, and does not pass anything on.** It reads its input from session state and keeps its result there.
- **Schemas have no list type.**

So the pipeline hands work over **through files on disk**:

- The indexing nodes pass one `FileGroups` record down the chain. Its three fields hold JSON lists as text.
- The last indexing node writes `docs/manifest.json`.
- The loop's agents read the manifest and the source files through **tools**.
- Tools also write the `.docx` files.

The critic's `record_review` tool writes `output/brd.docx` every time the critic reaches a verdict, choosing the disclaimer to match. So whichever way the loop ends, the right file is already there.

All paths are resolved from the exported project folder, so `docs/` and `output/` sit **inside** the project folder (`brd_pipeline/docs/`, `brd_pipeline/output/`). They do not depend on where `adk web` was started.

## Before you start

- A Gemini API key, for the agents and for the image summaries.
- Python packages, installed in step 7: `google-adk==2.0.0`, `python-docx`, `duckdb`.

## Step 1: open a blank graph

1. On the landing page, click **Google ADK**.
2. In the top bar, click **New**. This gives you an empty canvas with only the **START** card.

The project is named `untitled` until you rename it in step 6.

## Step 2: add two schemas

In the left pane, under **Schemas**, click **+ Schema** twice and set them up as follows. Rename a schema in its name box; the change saves when you press Enter. Use **+ field** to add fields, and leave **opt** unticked.

| Schema | Fields (all `str`) |
|---|---|
| `FileGroups` | `documents`, `tables`, `images` |
| `BrdDraft` | `title`, `content_json`, `draft_path` |

`FileGroups` carries the three file lists between the indexing nodes. `BrdDraft` is the loop's payload: the BRD's content as JSON, plus the path of the draft `.docx`.

## Step 3: add the five indexing nodes

For each row below:

1. Click **Function** in **Add Node**. The new node's editor opens.
2. Type the name in the editor header and press Enter.
3. Under **Configuration**, set `description`, `inputType` and `outputType`. Leave `emits` as is.
4. Paste the body into the `body` editor. It saves when you click outside it.

| # | Name | inputType | outputType | description |
|---|---|---|---|---|
| 1 | `scan_docs` | `str` | `FileGroups` | Delete docs/manifest.json and sort every file under docs/ into documents, tables and images. |
| 2 | `index_documents` | `FileGroups` | `FileGroups` | Add metadata and an excerpt for each document (python-docx for .docx). |
| 3 | `index_tables` | `FileGroups` | `FileGroups` | Add each table's columns, row count, sample rows and SQL view name (duckdb). |
| 4 | `index_images` | `FileGroups` | `FileGroups` | Add a filename and Gemini summary for each image. |
| 5 | `write_manifest` | `FileGroups` | `str` | Write docs/manifest.json. |

Then **wire them**. Drag from the right-hand handle of **START** to the left-hand handle of `scan_docs`. Next drag `scan_docs` → `index_documents` → `index_tables` → `index_images` → `write_manifest` the same way.

`scan_docs` must take `str` because it receives the text you type in `adk web` (`start`). It ignores that text.

Above each body editor, the editor shows the function signature the code runs in, e.g. `def _scan_docs_impl(node_input: str) -> FileGroups:`. `node_input` is the previous node's output, and `return` passes a value to the next node. Imports inside a body are fine.

### `scan_docs`
Deletes every `manifest.json` under `docs/` and the previous run's drafts. Then it sorts files using your `is_utf8` check. Images, tables and `.docx` are recognised by extension first, because a `.docx` file is a zip and is never valid UTF-8. Anything that is neither recognised nor UTF-8 (`.pdf`, `.xlsx`, binaries) is skipped.

```python
import json
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent
docs = root / "docs"
docs.mkdir(exist_ok=True)

# Start fresh: delete any manifest.json left by a previous run, at any depth,
# and the previous run's BRD drafts and review log.
for stale in docs.rglob("manifest.json"):
    stale.unlink()
shutil.rmtree(root / "output" / ".drafts", ignore_errors=True)


def is_utf8(file_path):
    try:
        with open(file_path, "r", encoding="utf-8", errors="strict") as f:
            # Read line by line to handle large files efficiently
            for _ in f:
                pass
        return True
    except UnicodeDecodeError:
        return False


IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff"}
TABLE_EXT = {".csv", ".tsv", ".parquet"}

documents, tables, images = [], [], []
for path in sorted(p for p in docs.rglob("*") if p.is_file()):
    if any(part.startswith(".") for part in path.relative_to(docs).parts):
        continue  # skip hidden files and folders
    rel = path.relative_to(root).as_posix()
    ext = path.suffix.lower()
    if ext in IMAGE_EXT:
        images.append({"path": rel})
    elif ext in TABLE_EXT:
        tables.append({"path": rel})
    elif ext == ".docx":
        documents.append({"path": rel, "kind": "docx"})
    elif is_utf8(path):
        documents.append({"path": rel, "kind": "text"})
    # anything else (pdf, xlsx, zip, ...) is skipped

return FileGroups(
    documents=json.dumps(documents),
    tables=json.dumps(tables),
    images=json.dumps(images),
)
```

### `index_documents`
```python
import json
from pathlib import Path

root = Path(__file__).resolve().parent
indexed = []
for entry in json.loads(node_input.documents or "[]"):
    path = root / entry["path"]
    info = dict(entry, size_bytes=path.stat().st_size)
    try:
        if entry.get("kind") == "docx":
            from docx import Document

            doc = Document(str(path))
            paras = [p for p in doc.paragraphs if p.text.strip()]
            text = "\n".join(p.text for p in paras)
            props = doc.core_properties
            info.update(
                title=props.title or path.stem,
                author=props.author or "",
                headings=[
                    p.text.strip()
                    for p in paras
                    if p.style is not None
                    and p.style.name.lower().startswith(("heading", "title"))
                ][:40],
                paragraphs=len(paras),
                tables=len(doc.tables),
                images=len(doc.inline_shapes),
                words=len(text.split()),
                excerpt=text[:1500],
            )
        else:
            text = path.read_text(encoding="utf-8")
            lines = text.splitlines()
            info.update(
                title=path.stem,
                extension=path.suffix.lower() or "(none)",
                lines=len(lines),
                words=len(text.split()),
                headings=[l.lstrip("#").strip() for l in lines if l.startswith("#")][:40]
                if path.suffix.lower() in {".md", ".markdown"}
                else [],
                excerpt=text[:1500],
            )
    except Exception as exc:  # keep going: one bad file must not stop the run
        info["error"] = f"{type(exc).__name__}: {exc}"
    indexed.append(info)

return FileGroups(
    documents=json.dumps(indexed),
    tables=node_input.tables,
    images=node_input.images,
)
```

### `index_tables`
This also gives each table a **SQL view name**: the path under `docs/`, without the extension, with every non-alphanumeric character turned into `_`. For example, `docs/finance/sales_q3.csv` becomes `finance_sales_q3`. The `query_tables` tool exposes each table under that name.

```python
import json
import re
from pathlib import Path

import duckdb

root = Path(__file__).resolve().parent
con = duckdb.connect()
indexed, used_views = [], set()
for entry in json.loads(node_input.tables or "[]"):
    path = root / entry["path"]
    # SQL view name the query_tables tool exposes this file under:
    # docs/finance/sales_q3.csv -> finance_sales_q3
    stem = Path(entry["path"]).relative_to("docs").with_suffix("").as_posix()
    view = re.sub(r"[^0-9a-zA-Z]+", "_", stem).strip("_").lower() or "table"
    if view[0].isdigit():
        view = "t_" + view
    base, n = view, 2
    while view in used_views:
        view, n = f"{base}_{n}", n + 1
    used_views.add(view)

    quoted = str(path).replace("'", "''")
    ext = path.suffix.lower()
    if ext == ".parquet":
        source = f"read_parquet('{quoted}')"
    elif ext == ".tsv":
        source = f"read_csv_auto('{quoted}', delim='\\t')"
    else:
        source = f"read_csv_auto('{quoted}')"

    info = dict(entry, view=view)
    try:
        info["columns"] = [
            {"name": row[0], "type": row[1]}
            for row in con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()
        ]
        info["row_count"] = con.execute(f"SELECT count(*) FROM {source}").fetchall()[0][0]
        cursor = con.execute(f"SELECT * FROM {source} LIMIT 3")
        names = [d[0] for d in cursor.description]
        info["sample_rows"] = [
            dict(zip(names, [str(v) for v in row])) for row in cursor.fetchall()
        ]
    except Exception as exc:
        info["error"] = f"{type(exc).__name__}: {exc}"
    indexed.append(info)

return FileGroups(
    documents=node_input.documents,
    tables=json.dumps(indexed),
    images=node_input.images,
)
```

### `index_images`
This uses the Gemini API directly (`google-genai`, which ships with ADK) to send each image with a summarising prompt. It is the same model access ADK agents use, and it reads the same `GOOGLE_API_KEY`.

```python
import json
import mimetypes
from pathlib import Path

root = Path(__file__).resolve().parent
entries = json.loads(node_input.images or "[]")
indexed = []
if entries:
    from google import genai
    from google.genai import types

    client = genai.Client()  # reads GOOGLE_API_KEY from the project's .env
    for entry in entries:
        path = root / entry["path"]
        info = dict(entry, filename=path.name)
        try:
            mime = mimetypes.guess_type(path.name)[0] or "image/png"
            response = client.models.generate_content(
                model="gemini-flash-latest",
                contents=[
                    types.Part.from_bytes(data=path.read_bytes(), mime_type=mime),
                    "Summarise this image in 2-3 sentences for a business analyst: "
                    "what it shows, any visible text or numbers, and what it is for.",
                ],
            )
            info["summary"] = (response.text or "").strip()
        except Exception as exc:
            info["error"] = f"{type(exc).__name__}: {exc}"
        indexed.append(info)

return FileGroups(
    documents=node_input.documents,
    tables=node_input.tables,
    images=json.dumps(indexed),
)
```

### `write_manifest`
```python
import json
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parent
manifest = {
    "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "root": "docs",
    "documents": json.loads(node_input.documents or "[]"),
    "tables": json.loads(node_input.tables or "[]"),
    "images": json.loads(node_input.images or "[]"),
}
(root / "docs" / "manifest.json").write_text(
    json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
)
return (
    f"docs/manifest.json written: {len(manifest['documents'])} documents, "
    f"{len(manifest['tables'])} tables, {len(manifest['images'])} images"
)
```

## Step 4: add the tools

In the left pane, under **Tools**, click **+ Tool** once for each tool below. For each tool:

1. Rename it.
2. Paste the description into **description — the LLM reads this**.
3. Set up the **params**:
   - Each new tool starts with one param, `text: str`. Rename it, or remove it with **✕**.
   - Add more params with **+ param**.
4. Set **returns** to `str`.
5. Paste the body.

| Tool | params (all `str`) | Given to |
|---|---|---|
| `read_manifest` | *(none: remove `text`)* | generator, critic, reviser |
| `read_document` | `path` | generator, critic, reviser |
| `describe_table` | `path` | generator, critic, reviser |
| `query_tables` | `sql` | generator, critic, reviser |
| `describe_image` | `path`, `question` | generator, critic, reviser |
| `render_brd` | `content_json`, `out_path`, `footer` | **nobody**: a helper the next two tools call |
| `save_brd_draft` | `content_json` | generator, reviser |
| `record_review` | `status`, `feedback` | critic |

The tools all end up in one generated file, `agent_tools.py`, so a tool can call another tool's code as `_<name>_impl(...)`. That is how `save_brd_draft` and `record_review` share `render_brd`.

### The duckdb tools: `describe_table` and `query_tables`
These let the agents understand and question the tables.

- **`describe_table`** profiles one file: row count, and each column's type, min, max, approximate distinct count and null %, plus the first 5 rows.
- **`query_tables`** runs one read-only SQL query over every table at once, using the view names from the manifest, so agents can filter, aggregate and join across files.

`query_tables` is read-only for two reasons:
- **Statement check:** it accepts only a single `SELECT` or `WITH` statement.
- **No file access:** it loads the tables into an in-memory database and then switches off duckdb's file access. A query can't read or write any other file, so `read_csv('/etc/passwd')` is refused.

When a query fails, the tool returns duckdb's error message, so the agent can fix its SQL and try again.

### `read_manifest`
*description:* Return docs/manifest.json: every document (with excerpt), table (with columns, row count, sample rows and its SQL view name) and image (with summary) under docs/. Call this first.
```python
from pathlib import Path

manifest = Path(__file__).resolve().parent / "docs" / "manifest.json"
if not manifest.exists():
    return "ERROR: docs/manifest.json not found. Run the indexing steps first."
return manifest.read_text(encoding="utf-8")
```

### `read_document`
*description:* Return the full text of one document under docs/ (.docx or any UTF-8 text file such as .md or code), truncated to 30000 characters. path is the manifest path, e.g. docs/specs/overview.docx.
```python
from pathlib import Path

root = Path(__file__).resolve().parent
target = (root / path).resolve()
if not target.exists():
    target = (root / "docs" / path).resolve()
if not target.is_relative_to(root / "docs") or not target.is_file():
    return f"ERROR: {path} is not a file under docs/. Use a path from the manifest."

if target.suffix.lower() == ".docx":
    from docx import Document

    doc = Document(str(target))
    lines = []
    for p in doc.paragraphs:
        if not p.text.strip():
            continue
        style = p.style.name.lower() if p.style is not None else ""
        lines.append(f"## {p.text}" if style.startswith(("heading", "title")) else p.text)
    for i, table in enumerate(doc.tables, 1):
        lines.append(f"\n[Table {i}]")
        for row in table.rows:
            lines.append(" | ".join(cell.text.strip() for cell in row.cells))
    text = "\n".join(lines)
else:
    try:
        text = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return f"ERROR: {path} is not a UTF-8 text or .docx file."

LIMIT = 30000
if len(text) > LIMIT:
    return text[:LIMIT] + f"\n\n[truncated: showing {LIMIT} of {len(text)} characters]"
return text
```

### `describe_table`
*description:* Profile one table file under docs/ (.csv, .tsv, .parquet) with duckdb: row count, each column's type, min, max, approximate distinct count and null %, and the first 5 rows. Call before writing SQL against a table.
```python
from pathlib import Path

import duckdb

root = Path(__file__).resolve().parent
target = (root / path).resolve()
if not target.exists():
    target = (root / "docs" / path).resolve()
if not target.is_relative_to(root / "docs") or not target.is_file():
    return f"ERROR: {path} is not a file under docs/. Use a table path from the manifest."

quoted = str(target).replace("'", "''")
ext = target.suffix.lower()
if ext == ".parquet":
    source = f"read_parquet('{quoted}')"
elif ext == ".tsv":
    source = f"read_csv_auto('{quoted}', delim='\\t')"
else:
    source = f"read_csv_auto('{quoted}')"

con = duckdb.connect()
try:
    rows = con.execute(f"SELECT count(*) FROM {source}").fetchall()[0][0]
    cursor = con.execute(f"SUMMARIZE SELECT * FROM {source}")
    stat_cols = [d[0] for d in cursor.description]
    stat_rows = cursor.fetchall()
    cursor = con.execute(f"SELECT * FROM {source} LIMIT 5")
    sample_cols = [d[0] for d in cursor.description]
    sample_rows = cursor.fetchall()
except duckdb.Error as exc:
    return f"ERROR from duckdb: {exc}"

idx = {name: i for i, name in enumerate(stat_cols)}
out = [f"Table {path}: {rows} rows, {len(stat_rows)} columns", "",
       "column | type | min | max | distinct (approx) | null %"]
for r in stat_rows:
    out.append(" | ".join(str(r[idx[k]]) for k in (
        "column_name", "column_type", "min", "max", "approx_unique", "null_percentage")))
out += ["", "First 5 rows:", " | ".join(sample_cols)]
out += [" | ".join(str(v) for v in row) for row in sample_rows]
return "\n".join(out)
```

### `query_tables`
*description:* Run one read-only duckdb SQL query (SELECT or WITH) over every table under docs/. Each table is available under the 'view' name listed in the manifest (docs/finance/sales_q3.csv -> finance_sales_q3); joins across tables are allowed. Returns up to 50 rows as a markdown table, or the duckdb error so you can fix the SQL.
```python
import json
import re
from pathlib import Path

import duckdb

root = Path(__file__).resolve().parent
manifest = root / "docs" / "manifest.json"
if not manifest.exists():
    return "ERROR: docs/manifest.json not found. Run the indexing steps first."
tables = [t for t in json.loads(manifest.read_text(encoding="utf-8")).get("tables", [])
          if t.get("view") and not t.get("error")]

statement = sql.strip().rstrip(";").strip()
if ";" in statement:
    return "ERROR: send one statement at a time."
if not re.match(r"(?is)^(select|with)\b", statement):
    return "ERROR: read-only. Only SELECT or WITH queries are allowed."

# Load every table into an in-memory database, then cut off file access, so the
# query can only see these tables and cannot read or write anything on disk.
con = duckdb.connect()
for t in tables:
    quoted = str(root / t["path"]).replace("'", "''")
    ext = Path(t["path"]).suffix.lower()
    if ext == ".parquet":
        source = f"read_parquet('{quoted}')"
    elif ext == ".tsv":
        source = f"read_csv_auto('{quoted}', delim='\\t')"
    else:
        source = f"read_csv_auto('{quoted}')"
    con.execute(f'CREATE TABLE "{t["view"]}" AS SELECT * FROM {source}')
con.execute("SET enable_external_access = false")
con.execute("SET lock_configuration = true")

views = ", ".join(t["view"] for t in tables) or "(none)"
try:
    cursor = con.execute(f"SELECT * FROM ({statement}) AS q LIMIT 51")
    columns = [d[0] for d in cursor.description]
    rows = cursor.fetchall()
except duckdb.Error as exc:
    return f"ERROR from duckdb: {exc}\nAvailable tables: {views}"

lines = [" | ".join(columns), " | ".join("---" for _ in columns)]
lines += [" | ".join(str(v) for v in row) for row in rows[:50]]
if len(rows) > 50:
    lines.append("[more than 50 rows: add LIMIT, filters or aggregates]")
return "\n".join(lines)
```

### `describe_image`
*description:* Ask a question about one image under docs/ (path from the manifest) and get Gemini's answer. Use it to check what an image shows before embedding or approving it.
```python
import mimetypes
from pathlib import Path

from google import genai
from google.genai import types

root = Path(__file__).resolve().parent
target = (root / path).resolve()
if not target.exists():
    target = (root / "docs" / path).resolve()
if not target.is_relative_to(root / "docs") or not target.is_file():
    return f"ERROR: {path} is not a file under docs/. Use an image path from the manifest."

mime = mimetypes.guess_type(target.name)[0] or "image/png"
client = genai.Client()  # keep a reference: a closed client cannot send requests
response = client.models.generate_content(
    model="gemini-flash-latest",
    contents=[types.Part.from_bytes(data=target.read_bytes(), mime_type=mime), question],
)
return (response.text or "").strip() or "(no answer)"
```

### `render_brd`
*description:* Internal helper used by save_brd_draft and record_review; do not give it to an agent. Renders BRD content JSON to a .docx at out_path with python-docx (headings, paragraphs, bullets, tables, embedded images) and appends footer as a Disclaimer section.

The BRD content is JSON shaped like this:
`{"title": "...", "sections": [{"heading": "...", "level": 1, "paragraphs": ["..."], "bullets": ["..."], "tables": [{"columns": ["..."], "rows": [["..."]]}], "images": [{"path": "docs/...", "caption": "..."}]}]}`

Each section can have paragraphs, bullets, tables and images, in that order. Images in formats Word can't embed (`.webp`, `.svg`) are replaced with a note.

```python
import json
from pathlib import Path

from docx import Document
from docx.shared import Inches

root = Path(__file__).resolve().parent
content = json.loads(content_json)
EMBEDDABLE = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff"}

doc = Document()
doc.add_heading(content.get("title") or "Business Requirements Document", level=0)
skipped = []
for section in content.get("sections", []):
    level = min(max(int(section.get("level", 1)), 1), 3)
    doc.add_heading(str(section.get("heading", "")), level=level)
    for text in section.get("paragraphs", []):
        doc.add_paragraph(str(text))
    for text in section.get("bullets", []):
        doc.add_paragraph(str(text), style="List Bullet")
    for table in section.get("tables", []):
        columns = [str(c) for c in table.get("columns", [])]
        rows = table.get("rows", [])
        if not columns:
            continue
        grid = doc.add_table(rows=1, cols=len(columns), style="Table Grid")
        for cell, name in zip(grid.rows[0].cells, columns):
            cell.text = name
        for row in rows:
            for cell, value in zip(grid.add_row().cells, row):
                cell.text = str(value)
    for image in section.get("images", []):
        img = (root / str(image.get("path", ""))).resolve()
        if not img.exists():
            img = (root / "docs" / str(image.get("path", ""))).resolve()
        if img.is_file() and img.is_relative_to(root / "docs") and img.suffix.lower() in EMBEDDABLE:
            doc.add_picture(str(img), width=Inches(6))
            if image.get("caption"):
                doc.add_paragraph(str(image["caption"]), style="Caption")
        else:
            skipped.append(str(image.get("path")))
            doc.add_paragraph(f"[Image not embedded: {image.get('path')}]")

doc.add_heading("Disclaimer", level=1)
for text in footer.split("\n\n"):
    if text.strip():
        doc.add_paragraph(text.strip())

out = (root / out_path).resolve()
out.parent.mkdir(parents=True, exist_ok=True)
doc.save(str(out))
note = f" Images not embedded: {', '.join(skipped)}." if skipped else ""
return f"Saved {out_path}.{note}"
```

### `save_brd_draft`
*description:* Save the BRD draft. content_json must be JSON shaped like {"title": "...", "sections": [{"heading": "...", "level": 1, "paragraphs": ["..."], "bullets": ["..."], "tables": [{"columns": ["..."], "rows": [["..."]]}], "images": [{"path": "docs/...", "caption": "..."}]}]} with image paths taken from the manifest. Writes output/.drafts/brd_draft.docx (images embedded) and returns its path, or an ERROR to fix and retry.
```python
import json
from pathlib import Path

root = Path(__file__).resolve().parent
try:
    content = json.loads(content_json)
except json.JSONDecodeError as exc:
    return f"ERROR: content_json is not valid JSON ({exc}). Fix it and call again."
if not isinstance(content, dict) or not content.get("title") or not content.get("sections"):
    return "ERROR: content_json needs a non-empty 'title' and a non-empty 'sections' list."

missing = []
for section in content["sections"]:
    for image in section.get("images", []):
        p = str(image.get("path", ""))
        if not ((root / p).is_file() or (root / "docs" / p).is_file()):
            missing.append(p)
if missing:
    return f"ERROR: these image paths do not exist: {', '.join(missing)}. Use image paths from the manifest."

drafts = root / "output" / ".drafts"
drafts.mkdir(parents=True, exist_ok=True)
(drafts / "brd_draft.json").write_text(json.dumps(content, indent=2), encoding="utf-8")
result = _render_brd_impl(
    json.dumps(content), "output/.drafts/brd_draft.docx", "DRAFT: not yet reviewed."
)
return f"{result} Set draft_path to output/.drafts/brd_draft.docx."
```

### `record_review`
*description:* Record your verdict on the latest saved draft. status is APPROVED or REVISE; feedback explains why, listing every issue when REVISE. Writes output/brd.docx with the matching disclaimer. Call exactly once per review, then return the same status and feedback.

This is where the approved / not-approved disclaimer is chosen. Change the disclaimer text here if you need different wording.

```python
import json
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parent
drafts = root / "output" / ".drafts"
draft = drafts / "brd_draft.json"
if not draft.exists():
    return ("ERROR: no draft has been saved yet. Return status REVISE with the "
            "feedback 'Call save_brd_draft before returning the draft.'")

approved = status.strip().upper() == "APPROVED"
log = drafts / "reviews.jsonl"
round_no = (len(log.read_text(encoding="utf-8").splitlines()) if log.exists() else 0) + 1
with log.open("a", encoding="utf-8") as f:
    f.write(json.dumps({
        "round": round_no,
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "APPROVED" if approved else "REVISE",
        "feedback": feedback,
    }) + "\n")

disclaimer = (
    "This Business Requirements Document was generated by an AI system from the "
    "source files in docs/ and checked by an automated reviewer. It may contain "
    "errors or omissions. Validate all requirements, figures and assumptions with "
    "the relevant stakeholders before relying on it."
)
if not approved:
    disclaimer += (
        "\n\nThis document was NOT approved by the reviewer. "
        f"Latest reviewer issue: {feedback}"
    )
_render_brd_impl(draft.read_text(encoding="utf-8"), "output/brd.docx", disclaimer)
verdict = "APPROVED" if approved else "REVISE"
return (f"Review round {round_no} recorded and output/brd.docx updated. "
        f"Now return status {verdict} with the same feedback.")
```

## Step 5: add the loop

1. Click **Loop** in **Add Node** and name it `brd_loop`.
2. Wire `write_manifest` → `brd_loop`. Nothing is passed along this edge; it only sets the order.
3. Under **Loop**, set:
   - `maxIterations`: `5`
   - `approvalPhrase`: `APPROVED`
   - `inputType`: `str`
   - `payloadType`: `BrdDraft`
4. Fill in the **generator**, **critic** and **reviser** sections as below. Each needs `model`, `instruction` (a plain text box) and `tools` (tick the boxes).

| Role | model | tools to tick |
|---|---|---|
| generator | `gemini-flash-latest` | read_manifest, read_document, describe_table, query_tables, describe_image, save_brd_draft |
| critic | `gemini-flash-latest` | read_manifest, read_document, describe_table, query_tables, describe_image, record_review |
| reviser | `gemini-flash-latest` | read_manifest, read_document, describe_table, query_tables, describe_image, save_brd_draft |

What each role receives:

- **Generator:** an empty `specifications` field. It has no upstream input, which is why its instruction starts from `read_manifest`.
- **Critic:** the current `BrdDraft` as `current`. It must answer with `status` and `feedback`.
- **Reviser:** `current` and `revision_feedback`.

The loop stops as soon as the critic's `status` is exactly `APPROVED`.

**generator instruction**
```text
You write a Business Requirements Document (BRD) from the files in docs/. Ignore the empty specifications field.
1. Call read_manifest to see every document, table and image.
2. Investigate the relevant sources: read_document for documents; for each table, describe_table first, then query_tables (read-only SQL over the manifest's view names, joins allowed) to get every figure you will cite; describe_image if a summary is not enough.
3. Write the BRD as content JSON shaped like {"title": "...", "sections": [{"heading": "...", "level": 1, "paragraphs": ["..."], "bullets": ["..."], "tables": [{"columns": ["..."], "rows": [["..."]]}], "images": [{"path": "docs/...", "caption": "..."}]}]}. Use these sections: Executive Summary, Business Objectives, Scope (in / out), Stakeholders, Current State, Business Requirements (numbered BR-1, BR-2, ... in a table with columns ID, Requirement, Priority, Source), Data and Reporting Requirements (cite the tables and figures you queried), Assumptions and Constraints, Risks, Glossary. Embed relevant images from docs/ by their manifest path with a caption. Every fact must come from a source; name the source file.
4. Call save_brd_draft with the content JSON. If it returns ERROR, fix the JSON and call again.
5. Return title, content_json (the exact JSON you saved) and draft_path.
```

**critic instruction**
```text
You are a strict BRD reviewer. The current draft is in current.content_json. Do your own investigation; do not trust the draft.
1. Call read_manifest, then check the draft's claims against the sources with read_document.
2. For every number taken from a table, run your own query_tables SQL (use describe_table first if needed) and compare.
3. Check that each embedded image is relevant and its caption is accurate (describe_image).
4. Check that every required section is present and every requirement names a source.
Then call record_review exactly once: status APPROVED if everything is accurate and complete, otherwise status REVISE with feedback listing each issue and how to fix it. Finally return the same status and feedback you passed to record_review.
```

**reviser instruction**
```text
You fix a BRD draft. current.content_json is the draft; revision_feedback lists the reviewer's issues.
1. Fix every issue. Re-check the sources with read_manifest, read_document, describe_table, query_tables and describe_image wherever a fix needs facts or figures.
2. Keep the same content JSON shape and keep everything that was not criticised.
3. Call save_brd_draft with the corrected JSON (fix and retry on ERROR).
4. Return title, content_json (the exact JSON you saved) and draft_path.
```

## Step 6: check, then name the project

1. In the top bar, the validity button should say **valid**. If it shows errors, click it: the **Preview** pane lists each one, and clicking a finding jumps to its node.
2. Use the file picker in **Preview** to read the generated code: `functions.py`, `agent_tools.py` and `loops.py`. Every role in `loops.py` should have its `tools=[...]` list.
3. The canvas has no name field, so the project is still `untitled`. To rename it:
   1. click **Save IR**;
   2. in the downloaded `untitled.agentgraph.json`, change `"name": "untitled"` to `"name": "brd_pipeline"`;
   3. click **Load IR** and pick the edited file.

## Step 7: export and run

Click **Export project**. That downloads `brd_pipeline.zip`, which unzips to a `brd_pipeline/` folder. Then:

```bash
cd brd_pipeline
printf 'python-docx\nduckdb\n' >> requirements.txt
pip install -r requirements.txt
cp .env.example .env    # then put your key after GOOGLE_API_KEY=
mkdir -p docs           # put your source files here, in any subfolders
cd ..
adk web .
```

In the browser, pick `brd_pipeline`, type `start` and send it. You'll see:

- the five indexing nodes run, and `docs/manifest.json` appear;
- the generator calling `read_manifest`, `read_document`, `describe_table`, `query_tables` and `save_brd_draft`;
- the critic re-running its own queries, then calling `record_review`;
- a reviser round each time the critic sends the draft back.

The run leaves these files behind:

| File | What it is |
|---|---|
| `docs/manifest.json` | the index of everything under `docs/` |
| `output/brd.docx` | **the BRD**, with images, requirement tables and the disclaimer at the end |
| `output/.drafts/brd_draft.docx` / `.json` | the latest draft |
| `output/.drafts/reviews.jsonl` | one line per critic verdict |

### When the loop runs out of rounds

If the critic hasn't approved after 5 rounds, the critic has still written `output/brd.docx` for its last review. That file carries the "NOT approved" disclaimer and the latest issue. The loop node then raises `RuntimeError: brd_loop failed to produce valid output after 5 rounds`, so `adk web` shows the run as failed.

That error comes *after* the file is saved, and you can ignore it. The reviser's last attempt, made after the 5th rejection, is never reviewed, so it stays only in `output/.drafts/`.

## Things to know

- **The critic must call `record_review` for `output/brd.docx` to be written.** Its instruction and the tool's reply both insist on it. If you see a draft in `.drafts/` but no `brd.docx`, check the run's tool calls.
- **Tables:** `.csv`, `.tsv` and `.parquet` only. For `.xlsx`, export it to CSV first.
- **Large inputs:** `read_document` returns at most 30,000 characters and `query_tables` at most 50 rows, so agents should aggregate in SQL rather than pull raw rows.
- **Cost:** a run makes one Gemini call per image, plus 3 to 15 agent turns with several tool calls each.
- **Models:** `gemini-flash-latest` is used throughout. For long or dense sources, consider a stronger model for the generator and critic.
