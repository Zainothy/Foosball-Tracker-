// supabase/functions/create-account/index.ts
//
// Sysadmin-only. Creates a new admin/referee login:
//   - generates a passphrase (the real login secret) via DinoPass
//   - creates the Supabase Auth user under a local-only synthetic email
//   - inserts the profiles row with the chosen role
//   - logs the creation to audit_log
//
// This MUST run as an Edge Function (not client-side) because it needs the
// service_role key, which can never be shipped in the browser bundle.
//
// Deploy with:  supabase functions deploy create-account
// Requires these secrets set on the project (see chat for how):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  (URL + ANON are auto-injected;
//   SERVICE_ROLE_KEY you set yourself via `supabase secrets set`)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAIL_DOMAIN = "internal.foosballmmr.local"; // never a real, deliverable address
const ALLOWED_ROLES = ["referee", "gameadmin", "sysadmin"];

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

function usernameToEmail(username: string): string {
  return `${normalizeUsername(username)}@${ADMIN_EMAIL_DOMAIN}`;
}

function validateUsername(username: string): string | null {
  const normalized = normalizeUsername(username);
  if (!normalized) return "Username is required";
  if (normalized.length < 2) return "Username must be at least 2 characters";
  if (normalized.length > 32) return "Username must be 32 characters or fewer";
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(normalized)) {
    return "Username must start and end with a letter or number";
  }
  return null;
}

async function dinopassWord(): Promise<string> {
  const res = await fetch("https://www.dinopass.com/password/simple");
  if (!res.ok) throw new Error(`DinoPass request failed: ${res.status}`);
  return (await res.text()).trim();
}
void dinopassWord; // kept only for reference; no longer called -- see localPassphrase below

// DinoPass is an external, unauthenticated third-party API with no
// documented uptime guarantee -- a single point of failure sitting in the
// middle of account creation, with no timeout or fallback. Generate a
// comparable passphrase locally instead (word + word + 2-digit number,
// same memorable shape DinoPass produces) so account creation never depends
// on a third party being reachable.
const PASSPHRASE_WORDS = [
  "amber", "badger", "canyon", "cedar", "coral", "delta", "ember", "falcon",
  "garnet", "harbor", "indigo", "jasper", "kelp", "lagoon", "maple", "nectar",
  "onyx", "pebble", "quartz", "ridge", "saffron", "tundra", "umber", "violet",
  "willow", "yonder", "zephyr", "cinder", "dune", "fern",
];
function localPassphrase(): string {
  const pick = () => PASSPHRASE_WORDS[Math.floor(Math.random() * PASSPHRASE_WORDS.length)];
  const a = pick();
  const b = pick();
  const num = Math.floor(Math.random() * 90) + 10;
  return `${a}${b.charAt(0).toUpperCase()}${b.slice(1)}${num}`;
}

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Client scoped to the CALLER's own JWT -- used only to verify who is asking.
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    // Privileged client -- service_role key, bypasses RLS, used only after the check below.
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: callerProfile, error: profileErr } = await admin
      .from("profiles")
      .select("username, role, active, call_sign")
      .eq("user_id", user.id)
      .single();

    if (profileErr || !callerProfile?.active || callerProfile.role !== "sysadmin") {
      return new Response(JSON.stringify({ error: "Only an active sysadmin can create accounts" }), {
        status: 403,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const username = normalizeUsername(String(body.username ?? ""));
    const usernameError = validateUsername(username);
    if (usernameError) {
      return new Response(JSON.stringify({ error: usernameError }), {
        status: 400,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    const role = body.role;
    if (!ALLOWED_ROLES.includes(role)) {
      return new Response(JSON.stringify({ error: `role must be one of ${ALLOWED_ROLES.join(", ")}` }), {
        status: 400,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    const { data: existingProfile } = await admin
      .from("profiles")
      .select("user_id")
      .eq("username", username)
      .maybeSingle();
    if (existingProfile) {
      return new Response(JSON.stringify({ error: "Username already exists" }), {
        status: 409,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    const passphrase = localPassphrase();
    const syntheticEmail = usernameToEmail(username);

    const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      password: passphrase,
      email_confirm: true, // synthetic address can never receive a real confirmation email
    });
    if (createErr || !newUser?.user) {
      return new Response(JSON.stringify({ error: createErr?.message ?? "User creation failed" }), {
        status: 500,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    const { error: insertErr } = await admin.from("profiles").insert({
      user_id: newUser.user.id,
      username,
      role,
      call_sign: username,
      created_by: user.id,
    });
    if (insertErr) {
      // Roll back the auth user so we don't leave an orphaned account with no profile.
      await admin.auth.admin.deleteUser(newUser.user.id);
      return new Response(JSON.stringify({ error: insertErr.message }), {
        status: 500,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    await admin.from("audit_log").insert({
      actor_user_id: user.id,
      actor_call_sign: callerProfile.username ?? callerProfile.call_sign,
      actor_role: callerProfile.role,
      action: "create_account",
      target_type: "profile",
      target_id: newUser.user.id,
      details: { username, role },
    });

    // Passphrase is returned exactly once. It is never stored anywhere in plaintext after this.
    return new Response(
      JSON.stringify({ username, passphrase, call_sign: username, role }),
      { status: 200, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }
});
