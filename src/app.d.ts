import type { SupabaseClient, User, Session } from '@supabase/supabase-js';
import type { Database } from '$lib/server/supabase/database.types';

declare global {
  namespace App {
    interface Locals {
      supabase: SupabaseClient<Database>;
      safeGetSession: () => Promise<{ session: Session | null; user: User | null }>;
      session: Session | null;
      user: User | null
    }

    interface PageData { session: Session | null; user: User | null }

    interface Platform {
      env: Env;
      ctx: ExecutionContext;
      caches: CacheStorage;
      cf?: IncomingRequestCfProperties
    }
  }
}

export {};
