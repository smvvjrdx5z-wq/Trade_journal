"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { enrichTrade } from "@/lib/trade-math";
import type { UserSettings } from "@/lib/types";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function getSettings(): Promise<UserSettings> {
  const { supabase, user } = await requireUser();
  const { data } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (data) return data as UserSettings;

  // Users created before the signup trigger existed: create the row now.
  const { data: created } = await supabase
    .from("user_settings")
    .insert({ user_id: user.id })
    .select()
    .single();
  return (created ?? {
    user_id: user.id,
    timezone: "UTC",
    default_risk_pct: 0.01,
    breakeven_threshold: 0.5,
    min_sample_size: 20,
    ingest_token: "",
  }) as UserSettings;
}

function num(form: FormData, name: string): number | null {
  const raw = (form.get(name) as string | null)?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function text(form: FormData, name: string): string {
  return ((form.get(name) as string | null) ?? "").trim();
}

function bool(form: FormData, name: string): boolean {
  return form.get(name) === "on" || form.get(name) === "true";
}

/** Balance immediately before `openTime`: starting balance + all P&L closed before it. */
async function balanceAtOpen(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  openTimeIso: string
): Promise<number | null> {
  const { data: accounts } = await supabase
    .from("accounts")
    .select("starting_balance")
    .eq("user_id", userId);
  const starting = (accounts ?? []).reduce(
    (a, acc) => a + Number(acc.starting_balance || 0),
    0
  );
  const { data: prior } = await supabase
    .from("trades")
    .select("net_pl")
    .eq("user_id", userId)
    .lt("close_time", openTimeIso);
  const realized = (prior ?? []).reduce((a, t) => a + Number(t.net_pl), 0);
  const balance = starting + realized;
  return balance > 0 ? balance : null;
}

// ===========================================================================
// Trades
// ===========================================================================
export async function saveTrade(formData: FormData) {
  const { supabase, user } = await requireUser();
  const settings = await getSettings();

  const id = text(formData, "id") || null;
  const openTime = new Date(text(formData, "open_time"));
  const closeTime = new Date(text(formData, "close_time"));
  if (Number.isNaN(openTime.getTime()) || Number.isNaN(closeTime.getTime())) {
    throw new Error("Open and close time are required.");
  }

  const grossPl = num(formData, "gross_pl") ?? 0;
  const commission = num(formData, "commission") ?? 0;
  const swap = num(formData, "swap") ?? 0;
  const fee = num(formData, "fee") ?? 0;
  const netPl = grossPl + commission + swap + fee;

  const direction = text(formData, "direction") === "Short" ? "Short" : "Long";
  const volume = num(formData, "volume") ?? 0;
  const entryPrice = num(formData, "entry_price") ?? 0;
  const exitPrice = num(formData, "exit_price") ?? 0;
  const stopLoss = num(formData, "stop_loss");
  const takeProfit = num(formData, "take_profit");
  const tickSize = num(formData, "tick_size");
  const tickValue = num(formData, "tick_value");
  const manualRisk = num(formData, "risk_amount");

  const enriched = enrichTrade(
    {
      direction,
      volume,
      open_time: openTime,
      close_time: closeTime,
      entry_price: entryPrice,
      exit_price: exitPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      net_pl: netPl,
      tick_size: tickSize,
      tick_value: tickValue,
      manual_risk_amount: manualRisk,
    },
    {
      timezone: settings.timezone,
      breakeven_threshold: settings.breakeven_threshold,
      default_risk_pct: settings.default_risk_pct,
      balance_at_open: await balanceAtOpen(
        supabase,
        user.id,
        openTime.toISOString()
      ),
    }
  );

  const row = {
    user_id: user.id,
    account_id: text(formData, "account_id") || null,
    symbol: text(formData, "symbol").toUpperCase(),
    direction,
    volume,
    open_time: openTime.toISOString(),
    close_time: closeTime.toISOString(),
    entry_price: entryPrice,
    exit_price: exitPrice,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    gross_pl: grossPl,
    commission,
    swap,
    fee,
    net_pl: netPl,
    tick_size: tickSize,
    tick_value: tickValue,
    ...enriched,
  };

  let tradeId = id;
  if (id) {
    const { error } = await supabase
      .from("trades")
      .update(row)
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await supabase
      .from("trades")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    tradeId = data.id;
  }

  revalidatePath("/", "layout");
  redirect(`/trades/${tradeId}`);
}

export async function deleteTrade(formData: FormData) {
  const { supabase, user } = await requireUser();
  const id = text(formData, "id");
  await supabase.from("trades").delete().eq("id", id).eq("user_id", user.id);
  revalidatePath("/", "layout");
  redirect("/trades");
}

/** The nine hand-written journal columns plus tags — never touched by ingest. */
export async function saveTradeJournal(formData: FormData) {
  const { supabase, user } = await requireUser();
  const id = text(formData, "id");

  const confidence = num(formData, "confidence");
  const { error } = await supabase
    .from("trades")
    .update({
      playbook_id: text(formData, "playbook_id") || null,
      setup_grade: text(formData, "setup_grade") || null,
      execution_grade: text(formData, "execution_grade") || null,
      followed_plan: formData.get("followed_plan") === null ? null : bool(formData, "followed_plan"),
      confidence: confidence && confidence >= 1 && confidence <= 5 ? confidence : null,
      entry_reason: text(formData, "entry_reason"),
      exit_reason: text(formData, "exit_reason"),
      lessons: text(formData, "lessons"),
    })
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) throw new Error(error.message);

  const tagIds = formData.getAll("tag_ids").map(String).filter(Boolean);
  await supabase
    .from("trade_tags")
    .delete()
    .eq("trade_id", id)
    .eq("user_id", user.id);
  if (tagIds.length) {
    await supabase
      .from("trade_tags")
      .insert(tagIds.map((tagId) => ({ trade_id: id, tag_id: tagId, user_id: user.id })));
  }

  revalidatePath(`/trades/${id}`);
  revalidatePath("/performance");
}

export async function uploadScreenshot(formData: FormData) {
  const { supabase, user } = await requireUser();
  const id = text(formData, "id");
  const file = formData.get("screenshot") as File | null;
  if (!file || !file.size) return;

  const ext = file.name.split(".").pop()?.toLowerCase() || "png";
  const path = `${user.id}/${id}.${ext}`;
  const { error } = await supabase.storage
    .from("screenshots")
    .upload(path, file, { upsert: true, contentType: file.type || "image/png" });
  if (error) throw new Error(error.message);

  await supabase
    .from("trades")
    .update({ screenshot_path: path })
    .eq("id", id)
    .eq("user_id", user.id);
  revalidatePath(`/trades/${id}`);
}

// ===========================================================================
// Playbooks
// ===========================================================================
export async function savePlaybook(formData: FormData) {
  const { supabase, user } = await requireUser();
  const id = text(formData, "id");
  const row = {
    name: text(formData, "name"),
    description: text(formData, "description"),
    rules: text(formData, "rules"),
    active: bool(formData, "active"),
  };
  if (!row.name) return;

  if (id) {
    await supabase.from("playbooks").update(row).eq("id", id).eq("user_id", user.id);
  } else {
    await supabase.from("playbooks").insert({ ...row, user_id: user.id, active: true });
  }
  revalidatePath("/playbooks");
}

export async function deletePlaybook(formData: FormData) {
  const { supabase, user } = await requireUser();
  await supabase
    .from("playbooks")
    .delete()
    .eq("id", text(formData, "id"))
    .eq("user_id", user.id);
  revalidatePath("/playbooks");
}

// ===========================================================================
// Tags
// ===========================================================================
export async function createTag(formData: FormData) {
  const { supabase, user } = await requireUser();
  const name = text(formData, "name");
  const category = text(formData, "category") || "Setup";
  if (!name) return;
  await supabase.from("tags").insert({ user_id: user.id, name, category });
  revalidatePath("/tags");
}

export async function deleteTag(formData: FormData) {
  const { supabase, user } = await requireUser();
  await supabase
    .from("tags")
    .delete()
    .eq("id", text(formData, "id"))
    .eq("user_id", user.id);
  revalidatePath("/tags");
}

// ===========================================================================
// Accounts
// ===========================================================================
export async function saveAccount(formData: FormData) {
  const { supabase, user } = await requireUser();
  const id = text(formData, "id");
  const row = {
    name: text(formData, "name"),
    login: num(formData, "login"),
    broker: text(formData, "broker"),
    server: text(formData, "server"),
    currency: text(formData, "currency") || "USD",
    account_type: text(formData, "account_type") === "Demo" ? "Demo" : "Live",
    starting_balance: num(formData, "starting_balance") ?? 0,
    current_balance: num(formData, "current_balance") ?? 0,
    current_equity: num(formData, "current_equity") ?? 0,
  };
  if (!row.name) return;

  if (id) {
    await supabase.from("accounts").update(row).eq("id", id).eq("user_id", user.id);
  } else {
    await supabase.from("accounts").insert({ ...row, user_id: user.id });
  }
  revalidatePath("/accounts");
}

export async function deleteAccount(formData: FormData) {
  const { supabase, user } = await requireUser();
  await supabase
    .from("accounts")
    .delete()
    .eq("id", text(formData, "id"))
    .eq("user_id", user.id);
  revalidatePath("/accounts");
}

// ===========================================================================
// Daily journal
// ===========================================================================
export async function saveDailyJournal(formData: FormData) {
  const { supabase, user } = await requireUser();
  const journalDate = text(formData, "journal_date");
  if (!journalDate) return;

  const row = {
    user_id: user.id,
    journal_date: journalDate,
    checked_calendar: bool(formData, "checked_calendar"),
    marked_levels: bool(formData, "marked_levels"),
    chose_playbooks: bool(formData, "chose_playbooks"),
    set_loss_limit: bool(formData, "set_loss_limit"),
    bias: text(formData, "bias"),
    went_well: text(formData, "went_well"),
    went_badly: text(formData, "went_badly"),
    do_differently: text(formData, "do_differently"),
    all_from_playbook: bool(formData, "all_from_playbook"),
    risk_respected: bool(formData, "risk_respected"),
    stopped_at_limit: bool(formData, "stopped_at_limit"),
    no_revenge: bool(formData, "no_revenge"),
    reviewed: bool(formData, "reviewed"),
  };

  const { error } = await supabase
    .from("daily_journal")
    .upsert(row, { onConflict: "user_id,journal_date" });
  if (error) throw new Error(error.message);
  revalidatePath(`/journal/${journalDate}`);
  revalidatePath("/journal");
}

// ===========================================================================
// Settings
// ===========================================================================
export async function saveSettings(formData: FormData) {
  const { supabase, user } = await requireUser();
  await getSettings(); // ensure the row exists

  const { error } = await supabase
    .from("user_settings")
    .update({
      timezone: text(formData, "timezone") || "UTC",
      default_risk_pct: num(formData, "default_risk_pct") ?? 0.01,
      breakeven_threshold: num(formData, "breakeven_threshold") ?? 0.5,
      min_sample_size: num(formData, "min_sample_size") ?? 20,
    })
    .eq("user_id", user.id);
  if (error) throw new Error(error.message);
  revalidatePath("/settings");
}

export async function regenerateIngestToken() {
  const { supabase, user } = await requireUser();
  await supabase
    .from("user_settings")
    .update({ ingest_token: crypto.randomUUID() })
    .eq("user_id", user.id);
  revalidatePath("/settings");
}
