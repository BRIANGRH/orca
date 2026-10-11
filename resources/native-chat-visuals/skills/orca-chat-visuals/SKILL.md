---
name: orca-chat-visuals
description: Show a chart, diagram, table, report or mockup inline in this Orca chat as an HTML
  page. Use when a visual would help the user understand your answer.
user-invocable: false
---

# Inline visuals in an Orca chat

Orca can show an HTML page inside your reply. Use one whenever a visual would make the answer
clearer.

## Writing the page

- Save it as an ordinary `.html` file in your working directory or a folder below it, where the user
  can open, edit and share it like any other file. If you can't write files there, skip the visual.
- One complete HTML file per visual, under 512 KB. Rewrite the same file to update it.
- Inline your styles, scripts and data. Inline in the chat, libraries and fonts load only from
  cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com, esm.sh, fonts.googleapis.com and
  fonts.gstatic.com, and the page can't make other network requests; use inline SVG or `data:`
  URLs for images.
- Don't size anything to the viewport height (`100vh`); Orca fits the inline frame to your content.
- Optional: inline, Orca's theme colors are available as CSS variables (`--background`,
  `--foreground`, `--muted-foreground`, `--border`, `--primary`, `--chart-1` to `--chart-5`). Give
  each a fallback, e.g. `var(--chart-1, #4e79a7)`, so the page also looks right opened on its own.

## Showing it

After the file exists, put this on its own line in your reply, outside any code block:

::orca-visual{path="reports/latency-by-region.html" title="Latency by region"}

`path` is relative to your working directory, with `/` between folders; `title` is optional.
At most 8 per reply.
