// Row types for the Supabase schema (snake_case matches the database).

export type Outcome = "Win" | "Loss" | "Breakeven";
export type Direction = "Long" | "Short";
export type Grade = "A" | "B" | "C" | "D" | "F";
export type TagCategory =
  | "Setup"
  | "Mistake"
  | "Emotion"
  | "Market Condition"
  | "Management";

export interface UserSettings {
  user_id: string;
  timezone: string;
  default_risk_pct: number;
  breakeven_threshold: number;
  min_sample_size: number;
  ingest_token: string;
}

export interface Account {
  id: string;
  user_id: string;
  login: number | null;
  name: string;
  broker: string;
  server: string;
  currency: string;
  account_type: "Live" | "Demo";
  starting_balance: number;
  current_balance: number;
  current_equity: number;
  active: boolean;
  last_synced_at: string | null;
}

export interface Playbook {
  id: string;
  user_id: string;
  name: string;
  description: string;
  rules: string;
  active: boolean;
}

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  category: TagCategory;
}

export interface Trade {
  id: string;
  user_id: string;
  account_id: string | null;
  position_id: number | null;
  symbol: string;
  direction: Direction;
  status: string;
  volume: number;
  open_time: string;
  close_time: string;
  entry_price: number;
  exit_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  gross_pl: number;
  commission: number;
  swap: number;
  fee: number;
  net_pl: number;
  mae: number | null;
  mfe: number | null;
  tick_size: number | null;
  tick_value: number | null;
  digits: number;
  magic: number;
  mt5_comment: string;
  screenshot_path: string | null;
  outcome: Outcome;
  session: string;
  trade_date: string;
  day_of_week: string;
  hour: number;
  duration_minutes: number;
  risk_amount: number | null;
  risk_is_estimated: boolean;
  planned_r: number | null;
  realized_r: number | null;
  return_pct: number | null;
  playbook_id: string | null;
  setup_grade: Grade | null;
  execution_grade: Grade | null;
  followed_plan: boolean | null;
  confidence: number | null;
  entry_reason: string;
  exit_reason: string;
  lessons: string;
}

export interface TradeTag {
  trade_id: string;
  tag_id: string;
  user_id: string;
}

export interface DailyJournal {
  id: string;
  user_id: string;
  journal_date: string;
  checked_calendar: boolean;
  marked_levels: boolean;
  chose_playbooks: boolean;
  set_loss_limit: boolean;
  bias: string;
  went_well: string;
  went_badly: string;
  do_differently: string;
  all_from_playbook: boolean;
  risk_respected: boolean;
  stopped_at_limit: boolean;
  no_revenge: boolean;
  reviewed: boolean;
}
