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

  let profile;
  try { profile = await fetchActiveProfile(); } catch (lookupError) {
    await supabase.auth.signOut();
    return { error: `Profile lookup failed: ${lookupError.message}` };
  }
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
  let profile;
  try { profile = await fetchActiveProfile(); } catch { profile = null; }
  if (!profile) {
    await supabase.auth.signOut();
    return null;
  }
  return profile;
}

async function fetchActiveProfile() {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  let { data, error } = await supabase
    .from("profiles")
    .select("user_id, username, role, call_sign, player_id, active, display_nickname, accent")
    .eq("user_id", userData.user.id).maybeSingle();
  if (error) {
    // Older deployments may not have the player_id column yet. Keep login
    // usable while migrations are rolled forward, without masking inactive
    // accounts as schema failures.
    const legacy = await supabase.from("profiles").select("user_id, username, role, call_sign, active").eq("user_id", userData.user.id).maybeSingle();
    data = legacy.data;
    error = legacy.error;
  }
  if (error) throw new Error(error.message || "Unable to read profile");
  if (!data) {
    const { data: provisioned, error: provisionError } = await supabase.rpc("ensure_player_profile");
    if (provisionError) {
      // Deactivated is an expected outcome here, not a lookup failure --
      // surface it the same way the direct-select path does below.
      if (/deactivated/i.test(provisionError.message || "")) return null;
      throw new Error(provisionError.message || "Player profile is not provisioned");
    }
    if (provisioned && !provisioned.active) return null;
    return provisioned || null;
  }
  if (!data.active) return null;
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
  const { data, error } = await supabase.rpc("admin_update_profile", {
    p_user_id: userId,
    p_role: changes.role ?? null,
    p_active: changes.active ?? null,
    p_player_id: changes.player_id ?? null,
  });
  if (error) return { error: error.message };
  return { ok: true, profile: data };
}

export async function listProfileRequests() {
  const { data, error } = await supabase.from("profile_requests").select("*").order("created_at", { ascending: false });
  return error ? { error: error.message } : { requests: data || [] };
}

export async function reviewProfileRequest(id, status, playerId = null) {
  const { data, error } = await supabase.rpc("review_profile_request", { p_request_id: id, p_status: status, p_player_id: playerId });
  return error ? { error: error.message } : { request: data };
}

// Authorization catalogue reads are kept in one place so the admin workspace
// can explain the current policy without duplicating Supabase query details.
export async function listAuthorizationModel() {
  const [roles, capabilities, grants, members] = await Promise.all([
    supabase.from("authz_roles").select("id, name, rank, is_preset, active").eq("active", true).order("rank", { ascending: false }),
    supabase.from("authz_capabilities").select("id, description, category").order("category").order("id"),
    supabase.from("authz_role_capabilities").select("role_id, capability_id"),
    supabase.from("authz_user_roles").select("user_id, role_id"),
  ]);
  const error = roles.error || capabilities.error || grants.error || members.error;
  if (error) return { error: error.message };
  return {
    roles: roles.data || [],
    capabilities: capabilities.data || [],
    grants: grants.data || [],
    members: members.data || [],
  };
}

// Hierarchy/self-target checks happen server-side in the RPC -- these are
// thin wrappers, not the enforcement.
export async function assignAuthzRole(userId, roleId) {
  const { error } = await supabase.rpc("admin_assign_authz_role", { p_user_id: userId, p_role_id: roleId });
  return error ? { error: error.message } : { ok: true };
}
export async function revokeAuthzRole(userId, roleId) {
  const { error } = await supabase.rpc("admin_revoke_authz_role", { p_user_id: userId, p_role_id: roleId });
  return error ? { error: error.message } : { ok: true };
}
// effect: "ALLOW" | "DENY" | null (null clears the exception)
export async function setAuthzException(userId, capabilityId, effect) {
  const { error } = await supabase.rpc("admin_set_authz_exception", { p_user_id: userId, p_capability_id: capabilityId, p_effect: effect });
  return error ? { error: error.message } : { ok: true };
<<<<<<< HEAD
}

export const PROFILE_ACCENTS = ["amber", "mint", "coral", "violet", "sky", "gold"];
export async function setProfileCustomization(nickname, accent) {
  const { data, error } = await supabase.rpc("set_own_profile_customization", { p_nickname: nickname || null, p_accent: accent || null });
  return error ? { error: error.message } : { profile: data };
}

// Discord-style audit explorer. Filters are applied server-side so the
// 200-row cap doesn't silently hide older matches.
export async function listAuditLog({ action, targetType, actorCallSign, since, until } = {}) {
  let query = supabase.from("audit_log").select("id, actor_call_sign, actor_role, action, target_type, target_id, details, created_at").order("created_at", { ascending: false }).limit(200);
  if (action) query = query.eq("action", action);
  if (targetType) query = query.eq("target_type", targetType);
  if (actorCallSign) query = query.ilike("actor_call_sign", `%${actorCallSign}%`);
  if (since) query = query.gte("created_at", since);
  if (until) query = query.lte("created_at", until);
  const { data, error } = await query;
  return error ? { error: error.message } : { rows: data || [] };
=======
>>>>>>> origin/codex/phase3-authz-impl
}

// These calls intentionally use audited SECURITY DEFINER commands. Direct
// browser writes to authorization tables stay disabled by RLS.
export async function saveAuthorizationRole(role, capabilityIds) {
  const { data, error } = await supabase.rpc("admin_save_authz_role", {
    p_role_id: role.id || null,
    p_name: role.name,
    p_rank: Number(role.rank) || 0,
    p_capability_ids: capabilityIds || [],
  });
  if (error) return { error: error.message };
  return { role: data };
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

export async function deleteAccount(userId) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return { error: "Not authenticated" };

  const res = await fetch(
    `${supabase.supabaseUrl}/functions/v1/delete-account`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || "Account deletion failed" };
  return { ok: true };
}

export async function registerAccount(username, password) {
  if (!username?.trim() || !password || password.length < 8) {
    return { error: "Choose a username and a passphrase of at least 8 characters" };
  }
  const { data, error } = await supabase.auth.signUp({
    email: usernameToEmail(username),
    password,
    options: { data: { username: username.trim() } },
  });
  if (error || !data?.user) return { error: error?.message || "Account creation failed" };
  if (!data.session) return { error: "Signup needs email confirmation to be disabled in Supabase Auth for username accounts." };
  const profile = await fetchActiveProfile();
  return { profile: profile || { user_id: data.user.id, username: username.trim(), role: "player", active: true, player_id: null } };
}

export async function createProfileRequest(request) {
  const { data, error } = await supabase.from("profile_requests").insert({
    request_type: request.type,
    player_id: request.playerId || null,
    canonical_name: request.canonicalName || null,
  }).select().single();
  return error ? { error: error.message } : { request: data };
}

export async function createGameSubmission(payload) {
  const { data, error } = await supabase.from("game_submissions").insert({
    payload,
    played_at: payload.playedAt,
    status: "pending",
  }).select().single();
  return error ? { error: error.message } : { submission: data };
}

export async function listGameSubmissions() {
  const { data, error } = await supabase.from("game_submissions").select("*").eq("status", "pending").order("created_at", { ascending: false });
  return error ? { error: error.message } : { submissions: data || [] };
}

export async function reviewGameSubmission(id, status) {
  if (!id || !["approved", "rejected"].includes(status)) return { error: "Invalid review" };
  const { data, error } = await supabase.rpc("review_game_submission", { p_submission_id: id, p_status: status });
  return error ? { error: error.message } : { submission: data };
}
