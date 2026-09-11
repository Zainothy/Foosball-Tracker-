// supabase/functions/create-account/index.ts
//
// Sysadmin-only. Creates a new admin/referee login:
//   - generates a passphrase (the real login secret) via DinoPass
//   - generates a separate call_sign (what shows up in the audit log)
//   - creates the Supabase Auth user under a synthetic, non-guessable email
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

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function dinopassWord(): Promise<string> {
  const res = await fetch("https://www.dinopass.com/password/simple");
  if (!res.ok) throw new Error(`DinoPass request failed: ${res.status}`);
  return (await res.text()).trim();
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
      .select("role, active, call_sign")
      .eq("user_id", user.id)
      .single();

    if (profileErr || !callerProfile?.active || callerProfile.role !== "sysadmin") {
      return new Response(JSON.stringify({ error: "Only an active sysadmin can create accounts" }), {
        status: 403,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const role = body.role;
    if (!ALLOWED_ROLES.includes(role)) {
      return new Response(JSON.stringify({ error: `role must be one of ${ALLOWED_ROLES.join(", ")}` }), {
        status: 400,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    // Generate the two independent words. Loop on collision (call_sign is UNIQUE).
    const passphrase = await dinopassWord();
    let callSign = await dinopassWord();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: clash } = await admin.from("profiles").select("user_id").eq("call_sign", callSign).maybeSingle();
      if (!clash) break;
      callSign = await dinopassWord();
    }

    const emailLocalPart = (await sha256Hex(passphrase)).slice(0, 24);
    const syntheticEmail = `${emailLocalPart}@${ADMIN_EMAIL_DOMAIN}`;

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
      role,
      call_sign: callSign,
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
      actor_call_sign: callerProfile.call_sign,
      actor_role: callerProfile.role,
      action: "create_account",
      target_type: "profile",
      target_id: newUser.user.id,
      details: { role, call_sign: callSign },
    });

    // Passphrase is returned exactly once. It is never stored anywhere in plaintext after this.
    return new Response(
      JSON.stringify({ passphrase, call_sign: callSign, role }),
      { status: 200, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }
});
