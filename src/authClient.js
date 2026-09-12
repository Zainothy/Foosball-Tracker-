// src/authClient.js
//
// Username + passphrase login on top of Supabase Auth. Supabase still needs an
// email-shaped identifier internally, so usernames are mapped to local-only
// synthetic emails that users never need to see.

import { supabase } from "./supabaseClient";

const ADMIN_EMAIL_DOMAIN = "internal.foosballmmr.local";

function normalizeUsername(username) {
  return username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-");
}

function usernameToEmail(username) {
  return `${normalizeUsername(username)}@${ADMIN_EMAIL_DOMAIN}`;
}

// Returns { profile } on success, or { error } on failure. Never throws.
export async function signInWithUsername(username, passphrase) {
  if (!username || !username.trim()) return { error: "Enter a username" };
  if (!passphrase || !passphrase.trim()) return { error: "Enter a passphrase" };
  const email = usernameToEmail(username);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: passphrase.trim(),
  });
  if (error || !data?.user)
    return { error: "Incorrect username or passphrase" };

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
    .select("user_id, username, role, call_sign, active")
    .eq("user_id", userData.user.id)
    .single();
  if (error || !data || !data.active) return null;
  return data; // { user_id, username, role, call_sign, active }
}

// Fire-and-forget audit logging. Server derives actor identity from the JWT --
// a client can never spoof who performed an action.
export async function logAudit(
  action,
  targetType = null,
  targetId = null,
  details = null,
) {
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

// Sysadmin-only. Lists all admin/referee accounts (RLS: "Sysadmins can read all profiles").
export async function listProfiles() {
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, username, role, call_sign, active, created_at")
    .order("created_at", { ascending: false });
  if (error) return { error: error.message };
  return { profiles: data };
}

// Sysadmin-only. Changes role and/or active status on an existing account
// (RLS: "Sysadmins can update profiles"). Does not touch the passphrase --
// that lives in Supabase Auth, not this table, and isn't editable from here.
export async function updateProfile(userId, changes) {
  const { error } = await supabase
    .from("profiles")
    .update(changes)
    .eq("user_id", userId);
  if (error) return { error: error.message };
  await logAudit(
    changes.active === false
      ? "deactivate_account"
      : changes.active === true
        ? "reactivate_account"
        : "change_role",
    "profile",
    userId,
    changes,
  );
  return { ok: true };
}

// Sysadmin-only. Calls the create-account Edge Function.
export async function createAccount(username, role) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return { error: "Not authenticated" };

  const res = await fetch(
    `${supabase.supabaseUrl}/functions/v1/create-account`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, role }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || "Account creation failed" };
  return {
    username: body.username,
    passphrase: body.passphrase,
    callSign: body.call_sign,
    role: body.role,
  };
}
