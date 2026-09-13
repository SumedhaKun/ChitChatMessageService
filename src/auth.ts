import { createClient } from "@supabase/supabase-js";

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export type Authenticate = (token: string) => Promise<AuthenticatedUser | null>;

export function createSupabaseAuthenticator(): Authenticate {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
  }

  const supabase = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return async (token) => {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user.email) return null;
    return { id: data.user.id, email: data.user.email };
  };
}

export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1] ?? null;
}
