import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./server";

/**
 * Service-role client for the ingest API. Bypasses RLS — only ever use it
 * server-side, and only after the caller's ingest token has been verified.
 * Returns null when the key is not configured.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createSupabaseClient(SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
