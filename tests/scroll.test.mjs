import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function importSource(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function installDocument(initialOverflow = "") {
  const previousDocument = globalThis.document;
  const body = { style: { overflow: initialOverflow } };
  globalThis.document = { body };
  return {
    body,
    restore() {
      globalThis.document = previousDocument;
    },
  };
}

test("acquires once, supports nested locks, and restores the initial style", async () => {
  const documentHandle = installDocument("scroll");
  const { acquireScrollLock, releaseScrollLock } = await importSource("../src/lib/scrollLock.js");
  const first = {};
  const second = {};

  acquireScrollLock(first);
  acquireScrollLock(first);
  assert.equal(documentHandle.body.style.overflow, "hidden");

  acquireScrollLock(second);
  releaseScrollLock(first);
  assert.equal(documentHandle.body.style.overflow, "hidden");

  releaseScrollLock(second);
  assert.equal(documentHandle.body.style.overflow, "scroll");
  documentHandle.restore();
});

test("release is idempotent and does not overwrite changes without a lock", async () => {
  const documentHandle = installDocument("");
  const { acquireScrollLock, releaseScrollLock } = await importSource("../src/lib/scrollLock.js");
  const token = {};

  releaseScrollLock(token);
  assert.equal(documentHandle.body.style.overflow, "");

  acquireScrollLock(token);
  releaseScrollLock(token);
  releaseScrollLock(token);
  assert.equal(documentHandle.body.style.overflow, "");
  documentHandle.restore();
});

test("does nothing safely when a document body is unavailable", async () => {
  const previousDocument = globalThis.document;
  delete globalThis.document;
  const { acquireScrollLock, releaseScrollLock } = await importSource("../src/lib/scrollLock.js");
  const token = {};

  assert.doesNotThrow(() => acquireScrollLock(token));
  assert.doesNotThrow(() => releaseScrollLock(token));
  globalThis.document = previousDocument;
});