import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enrichTrade } from "@/lib/trade-math";

// Accepts the exact JSON payloads the NotionTradeJournal EA spools to disk
// (see mql5/Experts/NotionTradeJournal.mq5 and bridge models.Trade.from_ea_payload):
//
//   { "server_utc_offset_minutes": 120,
//     "account": { "login": …, "company": …, "balance": …, … },
//     "trade":   { "position_id": …, "symbol": …, "open_time": "YYYY-MM-DDTHH:MM:SS", … } }
//
// A single payload or an array of payloads. Auth is a per-user bearer token
// (Settings page). Idempotent on position_id: re-posting updates machine
// fields and never touches the hand-written journal columns.

export const dynamic = "force-dynamic";

function f(value: unknown, fallback = 0): number {
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
}

/** Parse the EA's broker-local `YYYY-MM-DDTHH:MM:SS` and shift to UTC. */
function toUtc(raw: string, offsetMinutes: number): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(
    String(raw ?? "")
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(asUtc - offsetMinutes * 60_000);
}

export async function POST(request: Request) {
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured on the server." },
      { status: 501 }
    );
  }

  const auth = request.headers.get("authorization") ?? "";
  const token =
    request.headers.get("x-ingest-token") ??
    (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "");
  if (!token) {
    return NextResponse.json({ error: "Missing ingest token." }, { status: 401 });
  }

  const { data: settings } = await admin
    .from("user_settings")
    .select("*")
    .eq("ingest_token", token)
    .maybeSingle();
  if (!settings) {
    return NextResponse.json({ error: "Invalid ingest token." }, { status: 401 });
  }
  const userId: string = settings.user_id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const payloads = Array.isArray(body) ? body : [body];
  if (payloads.length > 500) {
    return NextResponse.json(
      { error: "At most 500 payloads per request." },
      { status: 413 }
    );
  }

  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const payload of payloads as Record<string, any>[]) {
    const trade = payload?.trade;
    if (!trade || trade.position_id === undefined) {
      skipped += 1;
      errors.push("payload missing trade.position_id");
      continue;
    }

    const offset = Math.trunc(f(payload.server_utc_offset_minutes, 0));
    const openTime = toUtc(trade.open_time, offset);
    const closeTime = toUtc(trade.close_time, offset);
    if (!openTime || !closeTime) {
      skipped += 1;
      errors.push(`position ${trade.position_id}: bad open/close time`);
      continue;
    }

    // ---- Account upsert -------------------------------------------------
    let accountId: string | null = null;
    const account = payload.account ?? {};
    const login = Math.trunc(f(account.login, 0));
    if (login) {
      const accountRow = {
        user_id: userId,
        login,
        name:
          String(account.company || account.server || "MT5") + ` · ${login}`,
        broker: String(account.company ?? ""),
        server: String(account.server ?? ""),
        currency: String(account.currency ?? "USD"),
        account_type: account.is_demo ? "Demo" : "Live",
        current_balance: f(account.balance),
        current_equity: f(account.equity),
        last_synced_at: new Date().toISOString(),
      };
      const { data: existing } = await admin
        .from("accounts")
        .select("id, starting_balance")
        .eq("user_id", userId)
        .eq("login", login)
        .maybeSingle();
      if (existing) {
        accountId = existing.id;
        await admin.from("accounts").update(accountRow).eq("id", existing.id);
      } else {
        const { data: created } = await admin
          .from("accounts")
          .insert({ ...accountRow, starting_balance: f(account.balance) })
          .select("id")
          .single();
        accountId = created?.id ?? null;
      }
    }

    // ---- Balance immediately before this trade opened --------------------
    const { data: accounts } = await admin
      .from("accounts")
      .select("starting_balance")
      .eq("user_id", userId);
    const starting = (accounts ?? []).reduce(
      (a, acc) => a + f(acc.starting_balance),
      0
    );
    const { data: prior } = await admin
      .from("trades")
      .select("net_pl")
      .eq("user_id", userId)
      .lt("close_time", openTime.toISOString());
    const balanceAtOpen =
      starting + (prior ?? []).reduce((a, t) => a + f(t.net_pl), 0);

    const netPl = f(trade.net_pl);
    const enriched = enrichTrade(
      {
        direction: String(trade.direction) === "Short" ? "Short" : "Long",
        volume: f(trade.volume),
        open_time: openTime,
        close_time: closeTime,
        entry_price: f(trade.entry_price),
        exit_price: f(trade.exit_price),
        stop_loss: f(trade.stop_loss) || null,
        take_profit: f(trade.take_profit) || null,
        net_pl: netPl,
        tick_size: f(trade.tick_size) || null,
        tick_value: f(trade.tick_value) || null,
      },
      {
        timezone: settings.timezone,
        breakeven_threshold: f(settings.breakeven_threshold, 0.5),
        default_risk_pct: f(settings.default_risk_pct, 0.01),
        balance_at_open: balanceAtOpen > 0 ? balanceAtOpen : null,
      }
    );

    // Machine-owned fields only — journal columns stay untouched on update.
    const row = {
      user_id: userId,
      account_id: accountId,
      position_id: Math.trunc(f(trade.position_id)),
      symbol: String(trade.symbol ?? "UNKNOWN"),
      direction: String(trade.direction) === "Short" ? "Short" : "Long",
      volume: f(trade.volume),
      open_time: openTime.toISOString(),
      close_time: closeTime.toISOString(),
      entry_price: f(trade.entry_price),
      exit_price: f(trade.exit_price),
      stop_loss: f(trade.stop_loss) || null,
      take_profit: f(trade.take_profit) || null,
      gross_pl: f(trade.gross_pl),
      commission: f(trade.commission),
      swap: f(trade.swap),
      fee: f(trade.fee),
      net_pl: netPl,
      mae: trade.mae !== undefined ? f(trade.mae) : null,
      mfe: trade.mfe !== undefined ? f(trade.mfe) : null,
      tick_size: f(trade.tick_size) || null,
      tick_value: f(trade.tick_value) || null,
      digits: Math.trunc(f(trade.digits, 5)),
      magic: Math.trunc(f(trade.magic)),
      mt5_comment: String(trade.comment ?? ""),
      synced_at: new Date().toISOString(),
      ...enriched,
    };

    const { error } = await admin
      .from("trades")
      .upsert(row, { onConflict: "user_id,position_id" });
    if (error) {
      skipped += 1;
      errors.push(`position ${trade.position_id}: ${error.message}`);
      continue;
    }

    // ---- Optional screenshot (base64 PNG from the EA's spool) -----------
    const screenshotB64 = payload.screenshot_base64 ?? trade.screenshot_base64;
    if (typeof screenshotB64 === "string" && screenshotB64.length) {
      try {
        const bytes = Buffer.from(screenshotB64, "base64");
        const path = `${userId}/pos_${row.position_id}.png`;
        const { error: uploadError } = await admin.storage
          .from("screenshots")
          .upload(path, bytes, { upsert: true, contentType: "image/png" });
        if (!uploadError) {
          await admin
            .from("trades")
            .update({ screenshot_path: path })
            .eq("user_id", userId)
            .eq("position_id", row.position_id);
        }
      } catch {
        // A missing chart must not block the trade.
      }
    }

    synced += 1;
  }

  return NextResponse.json({ synced, skipped, errors });
}
