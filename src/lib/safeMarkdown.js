function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

export function safeMarkdownUrl(value) {
  const url = String(value ?? "").trim();

  if (!url || /[\u0000-\u001F\u007F]/.test(url)) return "#";
  if (/^https?:\/\//i.test(url)) return url;
  if (/^mailto:/i.test(url)) return url;
  if (url.startsWith("#")) return url;
  if (/^\/(?!\/)/.test(url)) return url;
  if (/^(?:\.\/|\.\.\/)/.test(url)) return url;

  return "#";
}

function calloutColor(type) {
  return {
    note: "var(--blue)",
    info: "var(--blue)",
    tip: "var(--green)",
    hint: "var(--green)",
    success: "var(--green)",
    check: "var(--green)",
    done: "var(--green)",
    warning: "var(--orange)",
    caution: "var(--orange)",
    attention: "var(--orange)",
    danger: "var(--red)",
    error: "var(--red)",
    bug: "var(--red)",
    important: "var(--amber)",
    quote: "var(--dimmer)",
    example: "var(--purple)",
  }[type] || "var(--blue)";
}

function calloutIcon(type) {
  return {
    important: "!",
    quote: '"',
    example: "≡",
  }[type] || "";
}

function renderInline(rawText, allowLinks = true) {
  const protectedParts = [];
  const protect = (html) => {
    const placeholder = `\u0000md-${protectedParts.length}\u0000`;
    protectedParts.push(html);
    return placeholder;
  };
  let text = String(rawText ?? "");

  text = text.replace(/`([^`]+)`/g, (_match, code) =>
    protect(`<code>${escapeHtml(code)}</code>`),
  );

  if (allowLinks) {
    text = text.replace(
      /\[([^\]]+)\]\(([^)\n]+)\)/g,
      (_match, label, url) =>
        protect(
          `<a href="${escapeAttribute(safeMarkdownUrl(url))}" target="_blank" rel="noopener noreferrer" style="color:var(--amber);text-decoration:underline">${renderInline(label, false)}</a>`,
        ),
    );
  }

  text = text.replace(
    /\[\[([^\]]+)\]\]/g,
    (_match, label) =>
      protect(
        `<span style="color:var(--amber)">${renderInline(label, false)}</span>`,
      ),
  );

  text = escapeHtml(text)
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/___(.+?)___/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+?)_/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>")
    .replace(
      /==(.+?)==/g,
      "<mark style=\"background:rgba(232,184,74,.25);color:var(--gold);padding:1px 3px;border-radius:3px\">$1</mark>",
    );

  return text.replace(/\u0000md-(\d+)\u0000/g, (_match, index) =>
    protectedParts[Number(index)] ?? "",
  );
}

export function renderMarkdown(markdown) {
  if (!markdown) return "";

  const lines = String(markdown).split("\n");
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (/^```/.test(line)) {
      const language = line.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(escapeHtml(lines[index]));
        index += 1;
      }
      output.push(
        `<pre style="background:var(--s2);border:1px solid var(--b2);border-radius:6px;padding:12px 14px;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.7;margin:8px 0">${language ? `<span style="font-size:10px;color:var(--dimmer);display:block;margin-bottom:6px;letter-spacing:1px;text-transform:uppercase">${escapeHtml(language)}</span>` : ""}${codeLines.join("\n")}</pre>`,
      );
      if (index < lines.length) index += 1;
      continue;
    }

    const calloutMatch = line.match(/^> \[!(\w+)\]\s*(.*)$/);
    if (calloutMatch) {
      const type = (calloutMatch[1] || "note").toLowerCase();
      const title = calloutMatch[2] || `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
      const bodyLines = [];
      index += 1;
      while (index < lines.length && /^> /.test(lines[index])) {
        bodyLines.push(lines[index].slice(2));
        index += 1;
      }
      const color = calloutColor(type);
      output.push(
        `<div style="border-left:3px solid ${color};background:color-mix(in srgb,${color} 8%,var(--s2));border-radius:0 6px 6px 0;padding:10px 14px;margin:8px 0"><div style="font-weight:700;color:${color};font-size:12px;margin-bottom:4px">${calloutIcon(type)} ${renderInline(title)}</div><div style="color:var(--dim);font-size:13px;line-height:1.7">${bodyLines.map((bodyLine) => renderInline(bodyLine)).join("<br>")}</div></div>`,
      );
      continue;
    }

    if (/^> /.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^> /.test(lines[index])) {
        quoteLines.push(lines[index].slice(2));
        index += 1;
      }
      output.push(
        `<blockquote style="border-left:3px solid var(--b2);padding:6px 14px;margin:6px 0;color:var(--dim);font-style:italic">${quoteLines.map((quoteLine) => renderInline(quoteLine)).join("<br>")}</blockquote>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6}) (.+)$/);
    if (heading) {
      const level = heading[1].length;
      const sizes = [28, 18, 15, 13, 13, 13];
      const colors = [
        "var(--amber)",
        "var(--text)",
        "var(--text)",
        "var(--dim)",
        "var(--dim)",
        "var(--dim)",
      ];
      output.push(
        `<div style="font-family:var(--disp);font-size:${sizes[level - 1]}px;font-weight:${level <= 2 ? 700 : 600};color:${colors[level - 1]};margin:${level === 1 ? "0 0 12px" : "14px 0 5px"};${level === 2 ? "border-bottom:1px solid var(--b1);padding-bottom:4px" : ""}">${renderInline(heading[2])}</div>`,
      );
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      output.push('<hr style="border:none;border-top:1px solid var(--b2);margin:14px 0">');
      index += 1;
      continue;
    }

    if (/^\|.+\|/.test(line)) {
      const tableLines = [];
      while (index < lines.length && /^\|/.test(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      if (tableLines.length >= 2) {
        const cells = (row) =>
          row
            .split("|")
            .filter((_cell, cellIndex, allCells) => cellIndex > 0 && cellIndex < allCells.length - 1)
            .map((cell) => cell.trim());
        const headers = cells(tableLines[0]);
        const alignments = cells(tableLines[1]).map((cell) => {
          const alignment = cell.trim();
          if (alignment.startsWith(":" ) && alignment.endsWith(":")) return "center";
          return alignment.endsWith(":") ? "right" : "left";
        });
        const rows = tableLines.slice(2).map(cells);
        output.push(
          `<div style="overflow-x:auto;margin:8px 0"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>${headers.map((header, cellIndex) => `<th style="text-align:${alignments[cellIndex] || "left"};padding:6px 10px;border-bottom:2px solid var(--b2);color:var(--dimmer);font-weight:600;font-size:10px;letter-spacing:.5px;text-transform:uppercase;background:var(--s2)">${renderInline(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row, rowIndex) => `<tr style="${rowIndex % 2 ? "background:rgba(255,255,255,.015)" : ""}">${row.map((cell, cellIndex) => `<td style="text-align:${alignments[cellIndex] || "left"};padding:6px 10px;border-bottom:1px solid var(--b1)">${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
        );
      }
      continue;
    }

    if (/^(\s*)([-*+]|\d+\.) /.test(line)) {
      const listLines = [];
      while (
        index < lines.length &&
        (/^(\s*)([-*+]|\d+\.) /.test(lines[index]) || /^\s{2,}\S/.test(lines[index]))
      ) {
        listLines.push(lines[index]);
        index += 1;
      }
      const ordered = /^\s*\d+\./.test(listLines[0]);
      const items = listLines.map((item) => {
        const listItem = item.match(/^(\s*)([-*+]|\d+\.) (.*)$/);
        if (!listItem) return "";
        const text = listItem[3];
        if (/^\[[ xX]\] /.test(text)) {
          const checked = /^\[[xX]\] /.test(text);
          const label = text.replace(/^\[[ xX]\] /, "");
          return `<li style="list-style:none;margin-left:-18px"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" ${checked ? "checked" : ""} disabled style="margin-top:2px;accent-color:var(--amber)"><span style="${checked ? "text-decoration:line-through;opacity:.5" : ""}">${renderInline(label)}</span></label></li>`;
        }
        return `<li>${renderInline(text)}</li>`;
      }).join("");
      output.push(
        ordered
          ? `<ol style="padding-left:20px;margin:6px 0">${items}</ol>`
          : `<ul style="padding-left:20px;margin:6px 0">${items}</ul>`,
      );
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    output.push(
      `<p style="margin-bottom:8px;line-height:1.7;color:var(--dim);font-size:13px">${renderInline(line)}</p>`,
    );
    index += 1;
  }

  return output.join("\n");
}