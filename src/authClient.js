// src/authClient.js
//
// Passphrase-only login on top of Supabase Auth. There is no username field --
// the passphrase itself is deterministically hashed into a synthetic email that
// Supabase Auth uses internally. Nobody ever sees or types that email.

import { supabase } from "./supabaseClient";

const ADMIN_EMAIL_DOMAIN = "internal.foosballmmr.local";

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function passphraseToEmail(passphrase) {
  const hash = await sha256Hex(passphrase.trim());
  return `${hash.slice(0, 24)}@${ADMIN_EMAIL_DOMAIN}`;
}

// Returns { profile } on success, or { error } on failure. Never throws.
export async function signInWithPassphrase(passphrase) {
  if (!passphrase || !passphrase.trim()) return { error: "Enter a passphrase" };
  const email = await passphraseToEmail(passphrase);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: passphrase.trim() });
  if (error || !data?.user) return { error: "Incorrect passphrase" };

  const profile = await fetchActiveProfile();
  if (!profile) {
    // Valid Supabase credentials but no active profile row -- revoked or never provisioned.
    await supabase.auth.signOut();
    return { error: "This login has been deactivated" };
  }
  return { profile };
}

export async function signOutAdmin() {
  await supabase.auth.signOut();
}

// Call on app load to silently restore a session (e.g. after a page refresh).
export async function restoreSession() {
  const { data } = await supabase.auth.getSession();
  if (!data?.session) return null;
  const profile = await fetchActiveProfile();
  if (!profile) {
    await supabase.auth.signOut();
    return null;
  }
  return profile;
}

async function fetchActiveProfile() {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, role, call_sign, active")
    .eq("user_id", userData.user.id)
    .single();
  if (error || !data || !data.active) return null;
  return data; // { user_id, role, call_sign, active }
}

// Fire-and-forget audit logging. Server derives actor identity from the JWT --
// a client can never spoof who performed an action.
export async function logAudit(action, targetType = null, targetId = null, details = null) {
  try {
    await supabase.rpc("log_audit_event", {
      p_action: action,
      p_target_type: targetType,
      p_target_id: targetId ? String(targetId) : null,
      p_details: details,
    });
  } catch (e) {
    console.warn("[audit] log failed:", e);
  }
}

// Sysadmin-only. Calls the create-account Edge Function.
export async function createAccount(role) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return { error: "Not authenticated" };

  const res = await fetch(`${supabase.supabaseUrl}/functions/v1/create-account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || "Account creation failed" };
  return { passphrase: body.passphrase, callSign: body.call_sign, role: body.role };
}
