import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { Database } from './database.types';

export type SupabaseAdminClient = SupabaseClient<Database>;

export function createSupabaseAdminClient(): SupabaseAdminClient {
  const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL;
  const serviceRoleKey = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error('MAVERO Supabase admin configuration is missing.');
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch }
  });
}
