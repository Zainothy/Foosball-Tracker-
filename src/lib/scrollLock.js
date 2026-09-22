const tokens = new Set();
let lockedBody = null;
let originalOverflow = null;

function currentBody() {
  return globalThis.document?.body ?? null;
}

export function acquireScrollLock(token) {
  if (tokens.has(token)) return;

  const body = currentBody();
  if (!body) return;

  tokens.add(token);
  if (tokens.size === 1) {
    lockedBody = body;
    originalOverflow = body.style.overflow;
    body.style.overflow = "hidden";
  }
}

export function releaseScrollLock(token) {
  if (!tokens.has(token)) return;

  tokens.delete(token);
  if (tokens.size === 0) {
    if (lockedBody) lockedBody.style.overflow = originalOverflow ?? "";
    lockedBody = null;
    originalOverflow = null;
  }
}