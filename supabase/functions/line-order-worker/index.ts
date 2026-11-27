import { createClient } from "npm:@supabase/supabase-js@2";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const workerSecret = Deno.env.get("LINE_WORKER_SECRET");

  if (
    !workerSecret ||
    req.headers.get("x-worker-secret") !== workerSecret
  ) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const lineToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  const lineUserId = Deno.env.get("LINE_USER_ID");

  if (!url || !serviceKey || !lineToken || !lineUserId) {
    return json({ error: "Missing configuration" }, 500);
  }

  const db = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const money = (n: number) =>
    Number(n || 0).toLocaleString("zh-TW");

  try {
    const expired = await db.rpc(
      "expire_line_notifications"
    );

    if (expired.error) {
      throw new Error("Expiration check failed");
    }

    const { data: jobs, error } = await db.rpc(
      "claim_line_notifications",
      { p_limit: 10 }
    );

    if (error) {
      throw new Error("Queue claim failed");
    }

    let sent = 0;
    let failed = 0;
    let unrecorded = 0;

    for (const job of jobs || []) {
      let success = false;
      let reason: string | null = null;

      try {
        const { data: order, error: orderError } =
          await db
            .from("orders")
            .select("*")
            .eq("id", job.order_id)
            .single();

        if (orderError || !order) {
          throw new Error("Order unavailable");
        }

        const { data: items, error: itemError } =
          await db
            .from("order_items")
            .select(
              "product_name,quantity,line_total"
            )
            .eq("order_id", job.order_id)
            .order("id");

        if (itemError || !items?.length) {
          throw new Error("Order items unavailable");
        }

        const details = items.map((item) =>
          `${item.product_name} × ${item.quantity}　$${money(item.line_total)}`
        ).join("\n");

        const message = [
          "🔔 內門新齋味",
          "2027 新春年菜｜新訂單通知",
          "",
          `訂單編號：${order.order_no}`,
          `訂購人：${order.customer_name}`,
          `取貨方式：${order.delivery_method}`,
          `出貨日期：${order.delivery_date}`,
          `付款方式：${order.payment_method}`,
          "",
          "【訂購明細】",
          details,
          "",
          `商品小計：$${money(order.subtotal)}`,
          `運費：$${money(order.shipping_fee)}`,
          `訂單總金額：NT$ ${money(order.total)}`,
          "",
          `訂單狀態：${order.status}`,
          "請至管理後台確認訂單。",
          "https://peshincho.github.io/neimen-xinzhaiwei/admin.html",
        ].join("\n");

        if (message.length > 5000) {
          throw new Error("Message too long");
        }

        const response = await fetch(
          "https://api.line.me/v2/bot/message/push",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${lineToken}`,
              "Content-Type": "application/json",
              "X-Line-Retry-Key": job.retry_key,
            },
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({
              to: lineUserId,
              messages: [
                {
                  type: "text",
                  text: message,
                },
              ],
            }),
          }
        );

        if (
          response.ok ||
          (
            response.status === 409 &&
            response.headers.has(
              "x-line-accepted-request-id"
            )
          )
        ) {
          success = true;
        } else {
          reason = `LINE HTTP ${response.status}`;
        }

      } catch (err) {
        reason = err instanceof Error
          ? err.message
          : "Notification failed";
      }

      const result = await db.rpc(
        "finish_line_notification",
        {
          p_id: job.id,
          p_lock_token: job.lock_token,
          p_success: success,
          p_error: reason,
        }
      );

      if (result.error || result.data !== true) {
        unrecorded++;
      } else if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    return json({
      success: unrecorded === 0,
      processed: jobs?.length || 0,
      sent,
      failed,
      unrecorded,
    }, unrecorded ? 500 : 200);

  } catch {
    return json({
      success: false,
      error: "Worker execution failed",
    }, 500);
  }
});
