export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      device_pairing_requests: {
        Row: {
          id: string
          secret_hash: string
          short_code: string
          status: string
          requested_device_type: string
          requested_device_name: string
          requested_browser: string | null
          requested_os: string | null
          requested_platform: string | null
          approved_by_user_id: string | null
          approved_at: string | null
          exchange_code: string | null
          // Added by 20261003000000_device_pairing_exchange_lease.sql.
          exchange_lease_until: string | null
          exchange_claimed_at: string | null
          exchange_attempts: number
          manual_handle_hash: string | null
          manual_handle_user_id: string | null
          manual_handle_expires_at: string | null
          created_at: string
          expires_at: string
          consumed_at: string | null
        }
        Insert: {
          id?: string
          secret_hash: string
          short_code: string
          status?: string
          requested_device_type?: string
          requested_device_name?: string
          requested_browser?: string | null
          requested_os?: string | null
          requested_platform?: string | null
          approved_by_user_id?: string | null
          approved_at?: string | null
          exchange_code?: string | null
          exchange_lease_until?: string | null
          exchange_claimed_at?: string | null
          exchange_attempts?: number
          manual_handle_hash?: string | null
          manual_handle_user_id?: string | null
          manual_handle_expires_at?: string | null
          created_at?: string
          expires_at: string
          consumed_at?: string | null
        }
        Update: {
          id?: string
          secret_hash?: string
          short_code?: string
          status?: string
          requested_device_type?: string
          requested_device_name?: string
          requested_browser?: string | null
          requested_os?: string | null
          requested_platform?: string | null
          approved_by_user_id?: string | null
          approved_at?: string | null
          exchange_code?: string | null
          exchange_lease_until?: string | null
          exchange_claimed_at?: string | null
          exchange_attempts?: number
          manual_handle_hash?: string | null
          manual_handle_user_id?: string | null
          manual_handle_expires_at?: string | null
          created_at?: string
          expires_at?: string
          consumed_at?: string | null
        }
        Relationships: []
      }
      device_sessions: {
        Row: {
          id: string
          user_id: string
          supabase_session_id: string
          device_id: string
          device_type: string
          device_name: string
          browser: string | null
          os: string | null
          platform: string | null
          ip_hash: string | null
          created_at: string
          last_seen_at: string
          revoked_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          supabase_session_id: string
          device_id?: string
          device_type?: string
          device_name?: string
          browser?: string | null
          os?: string | null
          platform?: string | null
          ip_hash?: string | null
          created_at?: string
          last_seen_at?: string
          revoked_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          supabase_session_id?: string
          device_id?: string
          device_type?: string
          device_name?: string
          browser?: string | null
          os?: string | null
          platform?: string | null
          ip_hash?: string | null
          created_at?: string
          last_seen_at?: string
          revoked_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'device_sessions_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'users'
            referencedSchema: 'auth'
            referencedColumns: ['id']
          }
        ]
      }
      app_settings: {
        Row: {
          id: number
          adult_mode_allow_logged_in: boolean
          adult_mode_allow_guest: boolean
          updated_at: string
        }
        Insert: {
          id?: number
          adult_mode_allow_logged_in?: boolean
          adult_mode_allow_guest?: boolean
          updated_at?: string
        }
        Update: {
          id?: number
          adult_mode_allow_logged_in?: boolean
          adult_mode_allow_guest?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      user_preferences: {
        Row: {
          user_id: string
          adult_mode_enabled: boolean
          updated_at: string
        }
        Insert: {
          user_id: string
          adult_mode_enabled?: boolean
          updated_at?: string
        }
        Update: {
          user_id?: string
          adult_mode_enabled?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          }
        ]
      }
      favorite_deletions: {
        Row: {
          content_id: string
          content_type: string
          deleted_at: string
          favorite_key: string
          user_id: string
        }
        Insert: {
          content_id: string
          content_type: string
          deleted_at?: string
          favorite_key: string
          user_id: string
        }
        Update: {
          content_id?: string
          content_type?: string
          deleted_at?: string
          favorite_key?: string
          user_id?: string
        }
        Relationships: []
      }
      favorites: {
        Row: {
          content_id: string
          content_type: string
          created_at: string
          favorite_key: string
          id: string
          snapshot: Json
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content_id: string
          content_type: string
          created_at?: string
          favorite_key: string
          id?: string
          snapshot?: Json
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content_id?: string
          content_type?: string
          created_at?: string
          favorite_key?: string
          id?: string
          snapshot?: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          role: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          role?: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      // Added by 20260918000000_phase1_stremio_addons.sql.
      // Phase 1 Stremio HTTP addon registry; configuration foundation only.
      // Admin-only CRUD via RLS; NO public read policy in Phase 1.
      streaming_addons: {
        Row: {
          id: string
          name: string
          slug: string
          description: string | null
          manifest_url: string
          enabled: boolean
          status: string
          ordering: number
          logo: string | null
          version: string | null
          id_property: string | null
          supported_types: string[]
          id_prefixes: string[]
          resources: string[]
          last_checked_at: string | null
          last_success_at: string | null
          last_error: string | null
          capabilities: Json
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          description?: string | null
          manifest_url: string
          enabled?: boolean
          status?: string
          ordering?: number
          logo?: string | null
          version?: string | null
          id_property?: string | null
          supported_types?: string[]
          id_prefixes?: string[]
          resources?: string[]
          last_checked_at?: string | null
          last_success_at?: string | null
          last_error?: string | null
          capabilities?: Json
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          description?: string | null
          manifest_url?: string
          enabled?: boolean
          status?: string
          ordering?: number
          logo?: string | null
          version?: string | null
          id_property?: string | null
          supported_types?: string[]
          id_prefixes?: string[]
          resources?: string[]
          last_checked_at?: string | null
          last_success_at?: string | null
          last_error?: string | null
          capabilities?: Json
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      streaming_categories: {
        Row: {
          created_at: string
          description: string | null
          enabled: boolean
          id: string
          name: string
          ordering: number
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          name: string
          ordering?: number
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          enabled?: boolean
          id?: string
          name?: string
          ordering?: number
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      streaming_config_meta: {
        Row: {
          id: number
          updated_at: string
          version: number
        }
        Insert: {
          id?: number
          updated_at?: string
          version?: number
        }
        Update: {
          id?: number
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      streaming_default_sources: {
        Row: {
          content_type: string
          source_id: string
          updated_at: string
        }
        Insert: {
          content_type: string
          source_id: string
          updated_at?: string
        }
        Update: {
          content_type?: string
          source_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "streaming_default_sources_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "streaming_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      streaming_provider_health: {
        Row: {
          consecutive_failures: number
          cooldown_until: string | null
          created_at: string
          failure_count: number
          last_checked_at: string | null
          last_failure_at: string | null
          last_failure_type: string | null
          last_success_at: string | null
          provider_id: string
          source_id: string
          status: string
          success_count: number
          updated_at: string
        }
        Insert: {
          consecutive_failures?: number
          cooldown_until?: string | null
          created_at?: string
          failure_count?: number
          last_checked_at?: string | null
          last_failure_at?: string | null
          last_failure_type?: string | null
          last_success_at?: string | null
          provider_id: string
          source_id: string
          status?: string
          success_count?: number
          updated_at?: string
        }
        Update: {
          consecutive_failures?: number
          cooldown_until?: string | null
          created_at?: string
          failure_count?: number
          last_checked_at?: string | null
          last_failure_at?: string | null
          last_failure_type?: string | null
          last_success_at?: string | null
          provider_id?: string
          source_id?: string
          status?: string
          success_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "streaming_provider_health_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "streaming_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "streaming_provider_health_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "streaming_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      streaming_providers: {
        Row: {
          adapter_id: string | null
          capabilities: Json
          created_at: string
          description: string | null
          enabled: boolean
          icon: string | null
          id: string
          integration_type: string
          name: string
          notes: string | null
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          adapter_id?: string | null
          capabilities?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          icon?: string | null
          id?: string
          integration_type?: string
          name: string
          notes?: string | null
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          adapter_id?: string | null
          capabilities?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          icon?: string | null
          id?: string
          integration_type?: string
          name?: string
          notes?: string | null
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      streaming_public_categories: {
        Row: {
          description: string | null
          enabled: boolean
          id: string
          name: string
          ordering: number
          slug: string
        }
        Insert: {
          description?: string | null
          enabled: boolean
          id: string
          name: string
          ordering: number
          slug: string
        }
        Update: {
          description?: string | null
          enabled?: boolean
          id?: string
          name?: string
          ordering?: number
          slug?: string
        }
        Relationships: []
      }
      streaming_public_providers: {
        Row: {
          capabilities: Json
          description: string | null
          enabled: boolean
          icon: string | null
          id: string
          integration_type: string
          name: string
          slug: string
          status: string
        }
        Insert: {
          capabilities?: Json
          description?: string | null
          enabled: boolean
          icon?: string | null
          id: string
          integration_type: string
          name: string
          slug: string
          status: string
        }
        Update: {
          capabilities?: Json
          description?: string | null
          enabled?: boolean
          icon?: string | null
          id?: string
          integration_type?: string
          name?: string
          slug?: string
          status?: string
        }
        Relationships: []
      }
      streaming_public_source_categories: {
        Row: {
          category_id: string
          created_at: string
          ordering: number
          source_id: string
        }
        Insert: {
          category_id: string
          created_at: string
          ordering: number
          source_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          ordering?: number
          source_id?: string
        }
        Relationships: []
      }
      streaming_public_sources: {
        Row: {
          audio_languages: string[]
          badge: string | null
          capabilities: Json
          description: string | null
          enabled: boolean
          icon: string | null
          id: string
          identifier_mode: string
          integration_type: string | null
          language: string | null
          name: string
          ordering: number
          provider_id: string
          quality_capability: string[]
          slug: string
          status: string
          subtitle_capability: boolean
          visibility: string
        }
        Insert: {
          audio_languages?: string[]
          badge?: string | null
          capabilities?: Json
          description?: string | null
          enabled: boolean
          icon?: string | null
          id: string
          identifier_mode: string
          integration_type?: string | null
          language?: string | null
          name: string
          ordering: number
          provider_id: string
          quality_capability?: string[]
          slug: string
          status: string
          subtitle_capability?: boolean
          visibility: string
        }
        Update: {
          audio_languages?: string[]
          badge?: string | null
          capabilities?: Json
          description?: string | null
          enabled?: boolean
          icon?: string | null
          id?: string
          identifier_mode?: string
          integration_type?: string | null
          language?: string | null
          name?: string
          ordering?: number
          provider_id?: string
          quality_capability?: string[]
          slug?: string
          status?: string
          subtitle_capability?: boolean
          visibility?: string
        }
        Relationships: []
      }
      streaming_source_categories: {
        Row: {
          category_id: string
          created_at: string
          ordering: number
          source_id: string
        }
        Insert: {
          category_id: string
          created_at?: string
          ordering?: number
          source_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          ordering?: number
          source_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "streaming_source_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "streaming_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "streaming_source_categories_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "streaming_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      streaming_sources: {
        Row: {
          anime_template: string | null
          audio_languages: string[]
          badge: string | null
          capabilities: Json
          created_at: string
          description: string | null
          enabled: boolean
          icon: string | null
          id: string
          identifier_mode: string
          integration_type: string | null
          language: string | null
          movie_template: string | null
          name: string
          notes: string | null
          ordering: number
          provider_id: string
          quality_capability: string[]
          series_template: string | null
          slug: string
          status: string
          subtitle_capability: boolean
          updated_at: string
          visibility: string
        }
        Insert: {
          anime_template?: string | null
          audio_languages?: string[]
          badge?: string | null
          capabilities?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          icon?: string | null
          id?: string
          identifier_mode?: string
          integration_type?: string | null
          language?: string | null
          movie_template?: string | null
          name: string
          notes?: string | null
          ordering?: number
          provider_id: string
          quality_capability?: string[]
          series_template?: string | null
          slug: string
          status?: string
          subtitle_capability?: boolean
          updated_at?: string
          visibility?: string
        }
        Update: {
          anime_template?: string | null
          audio_languages?: string[]
          badge?: string | null
          capabilities?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
          icon?: string | null
          id?: string
          identifier_mode?: string
          integration_type?: string | null
          language?: string | null
          movie_template?: string | null
          name?: string
          notes?: string | null
          ordering?: number
          provider_id?: string
          quality_capability?: string[]
          series_template?: string | null
          slug?: string
          status?: string
          subtitle_capability?: boolean
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "streaming_sources_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "streaming_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      // Added by 20260915000000_download_providers.sql.
      // Separate downloader registry (independent from streaming provider/source).
      download_providers: {
        Row: {
          id: string
          name: string
          slug: string
          description: string | null
          icon: string | null
          enabled: boolean
          is_default: boolean
          ordering: number
          supports_movie: boolean
          supports_tv: boolean
          movie_url_template: string | null
          tv_url_template: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          slug: string
          description?: string | null
          icon?: string | null
          enabled?: boolean
          is_default?: boolean
          ordering?: number
          supports_movie?: boolean
          supports_tv?: boolean
          movie_url_template?: string | null
          tv_url_template?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          description?: string | null
          icon?: string | null
          enabled?: boolean
          is_default?: boolean
          ordering?: number
          supports_movie?: boolean
          supports_tv?: boolean
          movie_url_template?: string | null
          tv_url_template?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      // Added by 20260915000000_download_providers.sql.
      // Independent cache-invalidation version counter for the downloader
      // registry (never shared with streaming_config_meta).
      download_providers_config_meta: {
        Row: {
          id: number
          version: number
          updated_at: string
        }
        Insert: {
          id?: number
          version?: number
          updated_at?: string
        }
        Update: {
          id?: number
          version?: number
          updated_at?: string
        }
        Relationships: []
      }
      watch_history: {
        Row: {
          completion_state: string
          content_id: string
          content_type: string
          created_at: string
          duration: number
          episode: number | null
          episode_title: string | null
          event_key: string
          event_type: string
          id: string
          occurred_at: string
          position_seconds: number
          season: number | null
          snapshot: Json
          user_id: string
        }
        Insert: {
          completion_state?: string
          content_id: string
          content_type: string
          created_at?: string
          duration?: number
          episode?: number | null
          episode_title?: string | null
          event_key: string
          event_type: string
          id?: string
          occurred_at?: string
          position_seconds?: number
          season?: number | null
          snapshot?: Json
          user_id: string
        }
        Update: {
          completion_state?: string
          content_id?: string
          content_type?: string
          created_at?: string
          duration?: number
          episode?: number | null
          episode_title?: string | null
          event_key?: string
          event_type?: string
          id?: string
          occurred_at?: string
          position_seconds?: number
          season?: number | null
          snapshot?: Json
          user_id?: string
        }
        Relationships: []
      }
      watch_progress: {
        Row: {
          completion_state: string
          content_id: string
          content_type: string
          created_at: string
          duration: number
          episode: number | null
          episode_title: string | null
          id: string
          last_watched_at: string
          position_seconds: number
          progress_key: string
          season: number | null
          selected_source_id: string | null
          snapshot: Json
          source_runtimes: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          completion_state?: string
          content_id: string
          content_type: string
          created_at?: string
          duration?: number
          episode?: number | null
          episode_title?: string | null
          id?: string
          last_watched_at?: string
          position_seconds?: number
          progress_key: string
          season?: number | null
          selected_source_id?: string | null
          snapshot?: Json
          source_runtimes?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          completion_state?: string
          content_id?: string
          content_type?: string
          created_at?: string
          duration?: number
          episode?: number | null
          episode_title?: string | null
          id?: string
          last_watched_at?: string
          position_seconds?: number
          progress_key?: string
          season?: number | null
          selected_source_id?: string | null
          snapshot?: Json
          source_runtimes?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      // Added by 20260915000000_download_providers.sql.
      // Sanitized public view of enabled download providers.
      download_providers_public: {
        Row: {
          id: string
          name: string
          slug: string
          description: string | null
          icon: string | null
          enabled: boolean
          is_default: boolean
          ordering: number
          supports_movie: boolean
          supports_tv: boolean
          movie_url_template: string | null
          tv_url_template: string | null
        }
        Insert: {
          id: string
          name: string
          slug: string
          description?: string | null
          icon?: string | null
          enabled: boolean
          is_default: boolean
          ordering: number
          supports_movie: boolean
          supports_tv: boolean
          movie_url_template?: string | null
          tv_url_template?: string | null
        }
        Update: {
          id?: string
          name?: string
          slug?: string
          description?: string | null
          icon?: string | null
          enabled?: boolean
          is_default?: boolean
          ordering?: number
          supports_movie?: boolean
          supports_tv?: boolean
          movie_url_template?: string | null
          tv_url_template?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      is_admin: { Args: never; Returns: boolean }
      refresh_streaming_public_config: { Args: never; Returns: undefined }
      // Added by 20260915000000_download_providers.sql.
      bump_download_providers_config_version: { Args: never; Returns: undefined }
      remove_favorite: {
        Args: {
          p_content_id: string
          p_content_type: string
          p_deleted_at?: string
          p_favorite_key: string
        }
        Returns: boolean
      }
      // Added by 20260912000000_batch_remove_favorites.sql.
      // Atomic batch removal of favorites + their watch_progress + tombstones.
      // Returns one row per input identity with ok/error so the caller can
      // report partial results honestly.
      batch_remove_favorites: {
        Args: { p_items: unknown }
        Returns: {
          content_type: string | null
          content_id: string | null
          ok: boolean | null
          error: string | null
        }[]
      }
      // Added by 20260922000000_phase3_watch_history_retention.sql.
      // SECURITY DEFINER function: prunes watch_history rows older than
      // the retention window. Returns the count of deleted rows.
      prune_old_watch_history: {
        Args: { retention_days: number }
        Returns: number
      }
      // Added by 20260925000000_phase6_provider_health_atomicity.sql.
      // SECURITY DEFINER function: atomically records a successful resolution
      // for a (provider_id, source_id) pair. Eliminates the READ-MODIFY-WRITE
      // race condition in the previous loadRow+upsertRow pattern.
      record_provider_health_success: {
        Args: { p_provider_id: string; p_source_id: string; p_checked_at?: string }
        Returns: undefined
      }
      // Added by 20260925000000_phase6_provider_health_atomicity.sql.
      // SECURITY DEFINER function: atomically records a transient failure
      // for a (provider_id, source_id) pair. Increments counters and sets
      // cooldown state in a single atomic UPDATE.
      record_provider_health_failure: {
        Args: { p_provider_id: string; p_source_id: string; p_failure_type: string; p_checked_at?: string }
        Returns: undefined
      }
      // Added by 20260929000000_device_pairing_claim_rpc.sql and REPLACED
      // by 20261003000000_device_pairing_exchange_lease.sql (old signature
      // (text, timestamptz) was dropped — the lease state machine needs a
      // different arg list; CREATE OR REPLACE would have created an
      // overload and PostgREST call ambiguity).
      //
      // SECURITY DEFINER function: atomically claims an approved (or
      // lease-EXPIRED exchanging) pairing request with a short lease.
      //
      // State machine: pending → approved → exchanging (lease) →
      // consumed | failed. Unlike the 20260929 version, the claim does
      // NOT consume the row and does NOT clear exchange_code — the
      // credential must survive a recoverable verifyOtp failure so the
      // TV can retry (release_device_pairing_exchange flips the row
      // back to approved; a crashed exchangeer's lease expiry allows a
      // takeover claim).
      //
      // The OLD exchange_code is captured via SELECT ... FOR UPDATE
      // (PostgREST's UPDATE ... RETURNING only yields NEW values).
      // Enforces p_max_attempts — beyond the cap the pairing is marked
      // 'failed' (terminal, credential cleared).
      //
      // Returns: at most one row { id, exchange_code, exchange_attempts }.
      //   - Winner: id = pairing row id, exchange_code = stored OTP.
      //   - Loser / not-eligible / attempts-exhausted: empty result set.
      claim_device_pairing: {
        Args: { p_secret_hash: string; p_lease_ms?: number; p_max_attempts?: number; p_now?: string }
        Returns: {
          id: string | null
          exchange_code: string | null
          exchange_attempts: number | null
        }[]
      }
      // Added by 20261003000000_device_pairing_exchange_lease.sql.
      // SECURITY DEFINER function: exchanging → consumed. Called by the
      // exchange endpoint AFTER verifyOtp succeeded AND the session
      // cookies were written. Clears exchange_code + lease in the same
      // atomic UPDATE. p_pairing_id binds the completion to the exact
      // claim cycle the caller won. Returns the row id, or empty when
      // the row was not in 'exchanging' for this caller.
      complete_device_pairing: {
        Args: { p_secret_hash: string; p_pairing_id: string; p_now?: string }
        Returns: {
          id: string | null
        }[]
      }
      // Added by 20261003000000_device_pairing_exchange_lease.sql.
      // SECURITY DEFINER function: exchanging → approved (safe
      // recovery). Called when verifyOtp failed WITHOUT consuming the
      // credential (transient network/5xx). The stored credential is
      // KEPT so the same one-time token can be retried. Never used
      // when GoTrue reports the token expired/invalid — that path is
      // fail_device_pairing (replay of a consumed credential must be
      // impossible). Returns the row id, or empty when not eligible.
      release_device_pairing_exchange: {
        Args: { p_secret_hash: string; p_pairing_id: string }
        Returns: {
          id: string | null
        }[]
      }
      // Added by 20261003000000_device_pairing_exchange_lease.sql.
      // SECURITY DEFINER function: exchanging → failed (terminal).
      // Called when the credential is definitively dead (GoTrue
      // otp_expired / invalid) or cookie establishment failed after a
      // successful verification (the token is consumed — retry can
      // never succeed). Clears the credential. Returns the row id, or
      // empty when not eligible.
      fail_device_pairing: {
        Args: { p_secret_hash: string; p_pairing_id: string; p_now?: string }
        Returns: {
          id: string | null
        }[]
      }
      // Added by 20260930000000_register_device_session_rpc.sql.
      // SECURITY DEFINER function: atomically registers or heartbeats
      // a device session. Closes the TOCTOU race between the hook's
      // isSessionRevoked() check and the previous registerCurrentSession()
      // SELECT-then-INSERT pattern.
      //
      // Why this exists: the unique partial index on
      // (user_id, supabase_session_id) WHERE revoked_at IS NULL means
      // a revoked row is EXCLUDED from the index — so a separate
      // INSERT after revocation would NOT violate the constraint and
      // would resurrect the revoked session. This RPC uses
      // SELECT ... FOR UPDATE to lock the row regardless of revoked_at
      // state, then either heartbeats (active), no-ops (revoked —
      // returns empty), or INSERTs (first-time).
      //
      // Returns: at most one row with the session fields + a
      // `registered` flag (true=INSERT, false=heartbeat/no-op,
      // empty result = session is revoked, do not resurrect).
      register_device_session: {
        Args: {
          p_user_id: string
          p_supabase_session_id: string
          p_device_id: string
          p_device_type: string
          p_device_name: string
          p_browser: string | null
          p_os: string | null
          p_platform: string | null
          p_ip_hash: string | null
          p_heartbeat_interval_ms?: number
          p_now?: string
        }
        Returns: {
          id: string | null
          user_id: string | null
          supabase_session_id: string | null
          device_id: string | null
          device_type: string | null
          device_name: string | null
          browser: string | null
          os: string | null
          platform: string | null
          ip_hash: string | null
          created_at: string | null
          last_seen_at: string | null
          revoked_at: string | null
          registered: boolean | null
        }[]
      }
      // Added by 20261002000000_phaseF_set_addon_link_types_rpc.sql.
      // Phase F §8: atomic merge of capabilities.downloaderLinkTypes.
      // SECURITY INVOKER — RLS still applies; only is_admin() callers
      // can mutate. Preserves all other capability keys via jsonb_set.
      set_addon_link_types: {
        Args: { p_addon_id: string; p_link_types: unknown }
        Returns: undefined
      }
      // Added by 20260926150000_source_badge_icon_reorder.sql.
      // Task 13: ATOMIC category source reorder. SECURITY DEFINER with an
      // explicit is_admin() check; validates the full assignment set and
      // renumbers to dense 0..N-1 inside one transaction (the
      // unique(category_id, ordering) constraint makes sequential updates
      // unsafe). Returns the number of assignments in the category.
      reorder_category_sources: {
        Args: { p_category_id: string; p_ordered_source_ids: string[] }
        Returns: number
      }
      // Added by 20260926150000_source_badge_icon_reorder.sql.
      // Task 13: ABSOLUTE addon position (1-based). SECURITY DEFINER with an
      // explicit is_admin() check and an advisory lock serializing reorder
      // operations; rejects out-of-range positions and renumbers 0..N-1.
      set_addon_position: {
        Args: { p_addon_id: string; p_position: number }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

