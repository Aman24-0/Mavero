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
          capabilities: Json
          description: string | null
          enabled: boolean
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
          capabilities?: Json
          description?: string | null
          enabled: boolean
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
          capabilities?: Json
          description?: string | null
          enabled?: boolean
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
          capabilities: Json
          created_at: string
          description: string | null
          enabled: boolean
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
          capabilities?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
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
          capabilities?: Json
          created_at?: string
          description?: string | null
          enabled?: boolean
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
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_admin: { Args: never; Returns: boolean }
      refresh_streaming_public_config: { Args: never; Returns: undefined }
      remove_favorite: {
        Args: {
          p_content_id: string
          p_content_type: string
          p_deleted_at?: string
          p_favorite_key: string
        }
        Returns: boolean
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

