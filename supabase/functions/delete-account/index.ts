// supabase/functions/delete-account/index.ts
//
// Sysadmin-only. Permanently deletes a login: removes the Auth user (the
// profiles row cascades via its FK) and logs the deletion to audit_log.
// Must run as an Edge Function -- needs the service_role key to call
// admin.auth.admin.deleteUser, which no RPC can do from inside Postgres.
//
// Deploy with:  supabase functions deploy delete-account

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const ROLE_RANK: Record<string, number> = { player: 0, referee: 1, gameadmin: 2, sysadmin: 3 };

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: callerProfile, error: profileErr } = await admin
      .from("profiles").select("username, role, active, call_sign").eq("user_id", user.id).single();
    if (profileErr || !callerProfile?.active || callerProfile.role !== "sysadmin") {
      return new Response(JSON.stringify({ error: "Only an active sysadmin can delete accounts" }), { status: 403, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }

    const body = await req.json().catch(() => ({}));
    const targetUserId = String(body.user_id ?? "");
    if (!targetUserId) {
      return new Response(JSON.stringify({ error: "user_id is required" }), { status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }
    if (targetUserId === user.id) {
      return new Response(JSON.stringify({ error: "You cannot delete your own account" }), { status: 400, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }

    const { data: targetProfile, error: targetErr } = await admin
      .from("profiles").select("username, role, call_sign").eq("user_id", targetUserId).single();
    if (targetErr || !targetProfile) {
      return new Response(JSON.stringify({ error: "Account not found" }), { status: 404, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }
    if ((ROLE_RANK[callerProfile.role] ?? 0) <= (ROLE_RANK[targetProfile.role] ?? 0)) {
      return new Response(JSON.stringify({ error: "You must strictly outrank the target account" }), { status: 403, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }

    const { error: deleteErr } = await admin.auth.admin.deleteUser(targetUserId);
    if (deleteErr) {
      return new Response(JSON.stringify({ error: deleteErr.message }), { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
    }

    await admin.from("audit_log").insert({
      actor_user_id: user.id,
      actor_call_sign: callerProfile.username ?? callerProfile.call_sign,
      actor_role: callerProfile.role,
      action: "admin_delete_profile",
      target_type: "profile",
      target_id: targetUserId,
      details: { username: targetProfile.username ?? targetProfile.call_sign, role: targetProfile.role },
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
  }
});
