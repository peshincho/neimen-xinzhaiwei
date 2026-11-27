import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const TEST_MESSAGE = "內門新齋味｜2027新春年菜 LINE 訂單通知連線測試成功！";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://peshincho.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function jsonResponse(
  body: { success: boolean; error?: string },
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function getPublishableKey(): string {
  const rawKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (!rawKeys) {
    throw new Error("Supabase publishable keys are not configured");
  }

  let keys: unknown;
  try {
    keys = JSON.parse(rawKeys);
  } catch {
    throw new Error("Supabase publishable keys are invalid");
  }

  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error("Supabase publishable keys are invalid");
  }

  const key = Object.values(keys as Record<string, unknown>).find(
    (value): value is string =>
      typeof value === "string" && value.startsWith("sb_publishable_"),
  );

  if (!key) {
    throw new Error("No Supabase publishable key is configured");
  }

  return key;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const authorization = req.headers.get("Authorization");
    const bearerMatch = authorization?.match(/^Bearer\s+(\S+)$/i);

    if (!bearerMatch) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!supabaseUrl) {
      return jsonResponse(
        { success: false, error: "Server configuration error" },
        500,
      );
    }

    const supabase = createClient(supabaseUrl, getPublishableKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorization } },
    });

    const token = bearerMatch[1];
    const { data: authData, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authData.user) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const { data: adminRows, error: adminQueryError } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", authData.user.id)
      .limit(1);

    if (adminQueryError) {
      return jsonResponse(
        { success: false, error: "Unable to verify admin access" },
        500,
      );
    }

    if (!adminRows || adminRows.length === 0) {
      return jsonResponse({ success: false, error: "Forbidden" }, 403);
    }

    const lineChannelAccessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
    const lineAdminUserId = Deno.env.get("LINE_ADMIN_USER_ID");

    if (!lineChannelAccessToken || !lineAdminUserId) {
      return jsonResponse(
        { success: false, error: "Server configuration error" },
        500,
      );
    }

    try {
      const lineResponse = await fetch(LINE_PUSH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lineChannelAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: lineAdminUserId,
          messages: [{ type: "text", text: TEST_MESSAGE }],
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!lineResponse.ok) {
        return jsonResponse(
          { success: false, error: "LINE message delivery failed" },
          502,
        );
      }

      return jsonResponse({ success: true }, 200);
    } catch {
      return jsonResponse(
        { success: false, error: "LINE message delivery failed" },
        502,
      );
    }
  } catch {
    return jsonResponse({ success: false, error: "Internal server error" }, 500);
  }
});
