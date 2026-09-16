import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function importSource(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const { renderMarkdown, safeMarkdownUrl } = await importSource("../src/lib/safeMarkdown.js");

test("renders the existing Markdown surface", () => {
  const html = renderMarkdown(`# Heading\n\n**bold**, *italic*, ~~deleted~~, ==highlight== and \`code\`\n\n> quote\n\n> [!TIP] Keep this\n> Support text\n\n| Left | Right |\n| :--- | ---: |\n| one | two |\n\n- [x] Done\n- Open\n\n---`);

  assert.match(html, /Heading/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>deleted<\/del>/);
  assert.match(html, /<mark/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<blockquote/);
  assert.match(html, /Keep this/);
  assert.match(html, /<table/);
  assert.match(html, /type="checkbox" checked/);
  assert.match(html, /<hr/);
});

test("escapes user supplied HTML in every rendered context", () => {
  const html = renderMarkdown(`<img src=x onerror=alert(1)>\n\n> [!NOTE] <svg onload=alert(2)>\n> <script>alert(3)</script>\n\n| <b>bad</b> | ok |\n| --- | --- |\n| <iframe src=javascript:alert(4)> | value |`);

  assert.doesNotMatch(html, /<(?:img|svg|script|iframe)\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
});

test("escapes code fence language labels and code content", () => {
  const html = renderMarkdown('```"><img src=x onerror=alert(1)>\nconst value = \'<script>\'\n```');

  assert.doesNotMatch(html, /<(?:img|script)\b/i);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /const value = &#39;&lt;script&gt;&#39;/);
});

test("allows only safe URL schemes and safely encodes attributes", () => {
  const html = renderMarkdown(`[good](https://example.test/?a=1&b=2) [mail](mailto:team@example.test) [relative](/rules) [anchor](#top) [local](../rules) [bad](javascript:alert(1)) [protocol](//example.test) [quote](https://example.test/" onmouseover="alert(1))`);

  assert.match(html, /href="https:\/\/example\.test\/\?a=1&amp;b=2"/);
  assert.match(html, /href="mailto:team@example\.test"/);
  assert.match(html, /href="\/rules"/);
  assert.match(html, /href="#top"/);
  assert.match(html, /href="\.\.\/rules"/);
  assert.match(html, /href="#"[^>]*>bad<\/a>/);
  assert.match(html, /href="#"[^>]*>protocol<\/a>/);
  assert.match(html, /href="https:\/\/example\.test\/&quot; onmouseover=&quot;alert\(1"/);
  assert.doesNotMatch(html, /href="[^"]*"\s+onmouseover\s*=/i);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("does not let later formatting rewrite generated links", () => {
  const html = renderMarkdown(`[wiki URL](https://example.test/[[profile]]) and [[profile]]`);

  assert.match(html, /href="https:\/\/example\.test\/\[\[profile\]\]"/);
  assert.match(html, /<span style="color:var\(--amber\)">profile<\/span>/);
  assert.doesNotMatch(html, /href="[^\"]*<span/);
});

test("safeMarkdownUrl rejects dangerous, protocol-relative, and control-character URLs", () => {
  assert.equal(safeMarkdownUrl("javascript:alert(1)"), "#");
  assert.equal(safeMarkdownUrl("data:text/html,hi"), "#");
  assert.equal(safeMarkdownUrl("//example.test"), "#");
  assert.equal(safeMarkdownUrl("https://example.test/\nalert"), "#");
  assert.equal(safeMarkdownUrl("https://example.test"), "https://example.test");
});