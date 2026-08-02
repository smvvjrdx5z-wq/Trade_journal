//+------------------------------------------------------------------+
//|                                        NotionTradeJournal.mq5     |
//|  Captures closed positions and a marked-up H4 chart screenshot,   |
//|  then spools them to disk for the Python bridge to push to Notion.|
//|                                                                   |
//|  Attach to ONE chart only. It watches every symbol on the account.|
//+------------------------------------------------------------------+
#property copyright "MT5 Trade Journal"
#property version   "1.00"
#property strict

//--- Spooling -------------------------------------------------------
input string  InpSpoolFolder      = "NotionJournal"; // Spool subfolder inside MQL5\Files
input bool    InpBackfillOnInit   = true;            // Export past trades on attach
input int     InpBackfillDays     = 90;              // How far back to look

//--- Screenshots ----------------------------------------------------
input bool    InpCaptureChart     = true;            // Capture an H4 screenshot per trade
input int     InpShotWidth        = 1600;            // Screenshot width (px)
input int     InpShotHeight       = 900;             // Screenshot height (px)
input int     InpRightMarginBars  = 12;              // Bars of space right of the exit
input int     InpChartScale       = 3;               // Chart zoom, 0 (widest) to 5 (tightest)
input string  InpTemplateName     = "";              // Optional .tpl to apply, blank = default
input int     InpRenderWaitMs     = 900;             // Render settle time before capture

//--- Marker styling -------------------------------------------------
input color   InpEntryColor       = clrDodgerBlue;
input color   InpExitWinColor     = clrLimeGreen;
input color   InpExitLossColor    = clrOrangeRed;
input color   InpStopColor        = clrCrimson;
input color   InpTargetColor      = clrMediumSeaGreen;

//--- Internal state -------------------------------------------------
#define STATE_FILE   "processed.csv"
#define OPEN_FILE    "open_positions.csv"
#define SCHEMA_VER   1

// Live tracking of open positions so we capture the ORIGINAL stop/target
// and a true MAE/MFE rather than reconstructing them after the fact.
struct OpenSnapshot
{
   ulong    position_id;
   double   initial_sl;
   double   initial_tp;
   double   open_price;
   double   mae_price;      // worst price seen
   double   mfe_price;      // best price seen
   int      direction;      // +1 long, -1 short
};

OpenSnapshot g_open[];
ulong        g_processed[];
ulong        g_pending[];
string       g_spool;

//+------------------------------------------------------------------+
int OnInit()
{
   g_spool = InpSpoolFolder;
   if(!FolderCreate(g_spool))
   {
      // FolderCreate returns false when it already exists; only bail on a real error.
      if(GetLastError() != 0 && !FolderCreate(g_spool))
         ResetLastError();
   }

   LoadProcessed();
   LoadOpenSnapshots();

   PrintFormat("[NotionJournal] Spool directory: %s\\MQL5\\Files\\%s",
               TerminalInfoString(TERMINAL_DATA_PATH), g_spool);
   PrintFormat("[NotionJournal] Point this path at BRIDGE_SPOOL_DIR in the Python bridge .env");
   PrintFormat("[NotionJournal] Account %I64d on %s (%s)",
               AccountInfoInteger(ACCOUNT_LOGIN),
               AccountInfoString(ACCOUNT_SERVER),
               AccountInfoString(ACCOUNT_COMPANY));

   WriteAccountSnapshot();

   if(InpBackfillOnInit)
      Backfill();

   EventSetTimer(1);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   SaveOpenSnapshots();
}

//+------------------------------------------------------------------+
//| Trade events only queue work. Screenshotting opens and closes a   |
//| chart and sleeps, which must never happen on the trade thread.    |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest    &request,
                        const MqlTradeResult     &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD)
      return;
   if(trans.deal == 0)
      return;

   if(!HistoryDealSelect(trans.deal))
      return;

   long entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT)
      return;

   ulong pos = (ulong)HistoryDealGetInteger(trans.deal, DEAL_POSITION_ID);
   if(pos == 0)
      pos = trans.position;
   if(pos == 0)
      return;

   QueuePending(pos);
}

//+------------------------------------------------------------------+
void OnTimer()
{
   TrackOpenPositions();

   // Drain one position per tick so a burst of closes cannot stall the terminal.
   if(ArraySize(g_pending) > 0)
   {
      ulong pos = g_pending[0];
      RemovePendingAt(0);

      if(!AlreadyProcessed(pos))
      {
         if(ExportPosition(pos))
         {
            MarkProcessed(pos);
            WriteAccountSnapshot();
         }
      }
      DropOpenSnapshot(pos);
   }
}

//+------------------------------------------------------------------+
//| Track live positions: record the original SL/TP the first time we |
//| see a position, and keep a running MAE/MFE.                       |
//+------------------------------------------------------------------+
void TrackOpenPositions()
{
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;

      ulong  pos   = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
      string sym   = PositionGetString(POSITION_SYMBOL);
      long   ptype = PositionGetInteger(POSITION_TYPE);
      int    dir   = (ptype == POSITION_TYPE_BUY) ? 1 : -1;
      double last  = PositionGetDouble(POSITION_PRICE_CURRENT);

      int idx = FindOpenSnapshot(pos);
      if(idx < 0)
      {
         OpenSnapshot s;
         s.position_id = pos;
         s.initial_sl  = PositionGetDouble(POSITION_SL);
         s.initial_tp  = PositionGetDouble(POSITION_TP);
         s.open_price  = PositionGetDouble(POSITION_PRICE_OPEN);
         s.mae_price   = last;
         s.mfe_price   = last;
         s.direction   = dir;
         int n = ArraySize(g_open);
         ArrayResize(g_open, n + 1);
         g_open[n] = s;
         idx = n;
      }

      // Longs: adverse is lower, favourable is higher. Inverted for shorts.
      if(dir > 0)
      {
         if(last < g_open[idx].mae_price) g_open[idx].mae_price = last;
         if(last > g_open[idx].mfe_price) g_open[idx].mfe_price = last;
      }
      else
      {
         if(last > g_open[idx].mae_price) g_open[idx].mae_price = last;
         if(last < g_open[idx].mfe_price) g_open[idx].mfe_price = last;
      }
   }
}

//+------------------------------------------------------------------+
//| Reconstruct a round-turn position from its deals and write it out |
//+------------------------------------------------------------------+
bool ExportPosition(ulong position_id)
{
   if(!HistorySelectByPosition(position_id))
   {
      PrintFormat("[NotionJournal] Could not select history for position %I64u", position_id);
      return(false);
   }

   int deals = HistoryDealsTotal();
   if(deals == 0)
      return(false);

   string   symbol       = "";
   string   comment      = "";
   long     magic        = 0;
   int      direction    = 0;
   double   in_volume    = 0.0,  out_volume   = 0.0;
   double   in_notional  = 0.0,  out_notional = 0.0;
   double   gross        = 0.0,  commission   = 0.0, swap = 0.0, fee = 0.0;
   datetime open_time    = 0,    close_time   = 0;
   bool     saw_in       = false, saw_out     = false;

   for(int i = 0; i < deals; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0)
         continue;

      long dtype = HistoryDealGetInteger(ticket, DEAL_TYPE);
      if(dtype != DEAL_TYPE_BUY && dtype != DEAL_TYPE_SELL)
         continue;   // skip balance/credit/commission rows

      long     entry  = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      double   price  = HistoryDealGetDouble(ticket, DEAL_PRICE);
      double   volume = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      datetime dtime  = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);

      if(symbol == "")
         symbol = HistoryDealGetString(ticket, DEAL_SYMBOL);

      gross      += HistoryDealGetDouble(ticket, DEAL_PROFIT);
      commission += HistoryDealGetDouble(ticket, DEAL_COMMISSION);
      swap       += HistoryDealGetDouble(ticket, DEAL_SWAP);
      fee        += HistoryDealGetDouble(ticket, DEAL_FEE);

      if(entry == DEAL_ENTRY_IN)
      {
         if(!saw_in)
         {
            direction = (dtype == DEAL_TYPE_BUY) ? 1 : -1;
            magic     = HistoryDealGetInteger(ticket, DEAL_MAGIC);
            comment   = HistoryDealGetString(ticket, DEAL_COMMENT);
            open_time = dtime;
            saw_in    = true;
         }
         if(dtime < open_time)
            open_time = dtime;
         in_volume   += volume;
         in_notional += price * volume;
      }
      else if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
      {
         if(dtime > close_time)
            close_time = dtime;
         out_volume   += volume;
         out_notional += price * volume;
         saw_out       = true;
      }
   }

   // An OUT with no matching IN means the entry predates the loaded history.
   if(!saw_in || !saw_out || in_volume <= 0.0 || out_volume <= 0.0)
   {
      PrintFormat("[NotionJournal] Position %I64u is incomplete in history, skipping", position_id);
      return(false);
   }

   double entry_price = in_notional  / in_volume;
   double exit_price  = out_notional / out_volume;
   double net         = gross + commission + swap + fee;

   int    digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point  = SymbolInfoDouble(symbol, SYMBOL_POINT);

   // Original stop/target: prefer the live snapshot, fall back to order history.
   double sl = 0.0, tp = 0.0;
   int snap = FindOpenSnapshot(position_id);
   if(snap >= 0)
   {
      sl = g_open[snap].initial_sl;
      tp = g_open[snap].initial_tp;
   }
   if(sl == 0.0 && tp == 0.0)
      ReadOrderStops(position_id, sl, tp);

   // MAE/MFE: live snapshot if we have it, otherwise walk M1 bars.
   double mae_price = 0.0, mfe_price = 0.0;
   if(snap >= 0)
   {
      mae_price = g_open[snap].mae_price;
      mfe_price = g_open[snap].mfe_price;
   }
   else
   {
      ExcursionFromM1(symbol, direction, open_time, close_time, mae_price, mfe_price);
   }

   double mae_money = ExcursionToMoney(symbol, entry_price, mae_price, direction, out_volume);
   double mfe_money = ExcursionToMoney(symbol, entry_price, mfe_price, direction, out_volume);

   string shot = "";
   if(InpCaptureChart)
      shot = CaptureH4(position_id, symbol, direction, entry_price, exit_price,
                       sl, tp, open_time, close_time, net >= 0.0);

   return(WriteTradeJson(position_id, symbol, direction, out_volume, open_time, close_time,
                         entry_price, exit_price, sl, tp, gross, commission, swap, fee, net,
                         mae_money, mfe_money, magic, comment, digits, point, shot));
}

//+------------------------------------------------------------------+
//| Fall back to the position's orders for the original stop/target   |
//+------------------------------------------------------------------+
void ReadOrderStops(ulong position_id, double &sl, double &tp)
{
   int orders = HistoryOrdersTotal();
   datetime earliest = 0;
   for(int i = 0; i < orders; i++)
   {
      ulong ticket = HistoryOrderGetTicket(i);
      if(ticket == 0)
         continue;
      if((ulong)HistoryOrderGetInteger(ticket, ORDER_POSITION_ID) != position_id)
         continue;

      datetime setup = (datetime)HistoryOrderGetInteger(ticket, ORDER_TIME_SETUP);
      double   osl   = HistoryOrderGetDouble(ticket, ORDER_SL);
      double   otp   = HistoryOrderGetDouble(ticket, ORDER_TP);

      if(earliest == 0 || setup < earliest)
      {
         earliest = setup;
         sl = osl;
         tp = otp;
      }
      // A stop attached after entry still beats having none at all.
      if(sl == 0.0 && osl != 0.0) sl = osl;
      if(tp == 0.0 && otp != 0.0) tp = otp;
   }
}

//+------------------------------------------------------------------+
//| Reconstruct excursion from M1 bars when no live snapshot exists   |
//+------------------------------------------------------------------+
void ExcursionFromM1(const string symbol, int direction,
                     datetime from, datetime to,
                     double &mae_price, double &mfe_price)
{
   MqlRates rates[];
   int copied = CopyRates(symbol, PERIOD_M1, from, to, rates);
   if(copied <= 0)
   {
      mae_price = 0.0;
      mfe_price = 0.0;
      return;
   }

   double lo = rates[0].low, hi = rates[0].high;
   for(int i = 1; i < copied; i++)
   {
      if(rates[i].low  < lo) lo = rates[i].low;
      if(rates[i].high > hi) hi = rates[i].high;
   }

   if(direction > 0) { mae_price = lo; mfe_price = hi; }
   else              { mae_price = hi; mfe_price = lo; }
}

//+------------------------------------------------------------------+
//| Convert a price excursion into account currency                   |
//+------------------------------------------------------------------+
double ExcursionToMoney(const string symbol, double from_price, double to_price,
                        int direction, double volume)
{
   if(to_price == 0.0 || from_price == 0.0)
      return(0.0);

   double tick_size  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double tick_value = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   if(tick_size <= 0.0 || tick_value <= 0.0)
      return(0.0);

   double diff = (to_price - from_price) * direction;
   return((diff / tick_size) * tick_value * volume);
}

//+------------------------------------------------------------------+
//| Open a throwaway H4 chart, mark the trade up, screenshot, close   |
//+------------------------------------------------------------------+
string CaptureH4(ulong position_id, const string symbol, int direction,
                 double entry_price, double exit_price, double sl, double tp,
                 datetime open_time, datetime close_time, bool was_win)
{
   long chart = ChartOpen(symbol, PERIOD_H4);
   if(chart == 0)
   {
      PrintFormat("[NotionJournal] ChartOpen failed for %s (error %d)", symbol, GetLastError());
      return("");
   }

   string file = StringFormat("%s\\trade_%I64u_h4.png", g_spool, position_id);

   if(InpTemplateName != "")
      ChartApplyTemplate(chart, InpTemplateName);

   ChartSetInteger(chart, CHART_MODE, CHART_CANDLES);
   ChartSetInteger(chart, CHART_SHOW_GRID, false);
   ChartSetInteger(chart, CHART_SHOW_PERIOD_SEP, true);
   ChartSetInteger(chart, CHART_AUTOSCROLL, false);
   ChartSetInteger(chart, CHART_SHIFT, false);
   ChartSetInteger(chart, CHART_SCALE, InpChartScale);
   ChartSetInteger(chart, CHART_SHOW_OBJECT_DESCR, true);

   // Give the terminal a moment to pull H4 history for this symbol.
   for(int attempt = 0; attempt < 20; attempt++)
   {
      if(Bars(symbol, PERIOD_H4) > 100)
         break;
      Sleep(100);
   }

   DrawTradeMarkers(chart, symbol, direction, entry_price, exit_price, sl, tp,
                    open_time, close_time, was_win);

   // Scroll so the exit sits near the right edge with a little breathing room.
   int bars_back = iBarShift(symbol, PERIOD_H4, close_time, false);
   if(bars_back > InpRightMarginBars)
      ChartNavigate(chart, CHART_END, -(bars_back - InpRightMarginBars));
   else
      ChartNavigate(chart, CHART_END, 0);

   ChartRedraw(chart);
   Sleep(InpRenderWaitMs);

   bool ok = ChartScreenShot(chart, file, InpShotWidth, InpShotHeight, ALIGN_RIGHT);
   if(!ok)
      PrintFormat("[NotionJournal] ChartScreenShot failed for %s (error %d)", symbol, GetLastError());

   ChartClose(chart);
   return(ok ? StringFormat("trade_%I64u_h4.png", position_id) : "");
}

//+------------------------------------------------------------------+
void DrawTradeMarkers(long chart, const string symbol, int direction,
                      double entry_price, double exit_price, double sl, double tp,
                      datetime open_time, datetime close_time, bool was_win)
{
   string p = StringFormat("tj_%I64u_", (ulong)chart);
   color  exit_color = was_win ? InpExitWinColor : InpExitLossColor;

   // Entry arrow
   string n1 = p + "entry";
   if(ObjectCreate(chart, n1, direction > 0 ? OBJ_ARROW_BUY : OBJ_ARROW_SELL, 0, open_time, entry_price))
   {
      ObjectSetInteger(chart, n1, OBJPROP_COLOR, InpEntryColor);
      ObjectSetInteger(chart, n1, OBJPROP_WIDTH, 3);
      ObjectSetString(chart, n1, OBJPROP_TOOLTIP, direction > 0 ? "Entry (long)" : "Entry (short)");
   }

   // Exit arrow
   string n2 = p + "exit";
   if(ObjectCreate(chart, n2, direction > 0 ? OBJ_ARROW_SELL : OBJ_ARROW_BUY, 0, close_time, exit_price))
   {
      ObjectSetInteger(chart, n2, OBJPROP_COLOR, exit_color);
      ObjectSetInteger(chart, n2, OBJPROP_WIDTH, 3);
      ObjectSetString(chart, n2, OBJPROP_TOOLTIP, "Exit");
   }

   // Entry-to-exit path
   string n3 = p + "path";
   if(ObjectCreate(chart, n3, OBJ_TREND, 0, open_time, entry_price, close_time, exit_price))
   {
      ObjectSetInteger(chart, n3, OBJPROP_COLOR, exit_color);
      ObjectSetInteger(chart, n3, OBJPROP_WIDTH, 2);
      ObjectSetInteger(chart, n3, OBJPROP_STYLE, STYLE_SOLID);
      ObjectSetInteger(chart, n3, OBJPROP_RAY_RIGHT, false);
   }

   // Entry level
   string n4 = p + "entryline";
   if(ObjectCreate(chart, n4, OBJ_TREND, 0, open_time, entry_price, close_time, entry_price))
   {
      ObjectSetInteger(chart, n4, OBJPROP_COLOR, InpEntryColor);
      ObjectSetInteger(chart, n4, OBJPROP_STYLE, STYLE_DOT);
      ObjectSetInteger(chart, n4, OBJPROP_WIDTH, 1);
      ObjectSetInteger(chart, n4, OBJPROP_RAY_RIGHT, false);
   }

   // Stop and target, drawn across the life of the trade only
   if(sl > 0.0)
   {
      string n5 = p + "sl";
      if(ObjectCreate(chart, n5, OBJ_TREND, 0, open_time, sl, close_time, sl))
      {
         ObjectSetInteger(chart, n5, OBJPROP_COLOR, InpStopColor);
         ObjectSetInteger(chart, n5, OBJPROP_STYLE, STYLE_DASH);
         ObjectSetInteger(chart, n5, OBJPROP_WIDTH, 1);
         ObjectSetInteger(chart, n5, OBJPROP_RAY_RIGHT, false);
         ObjectSetString(chart, n5, OBJPROP_TOOLTIP, "Stop loss");
      }
   }
   if(tp > 0.0)
   {
      string n6 = p + "tp";
      if(ObjectCreate(chart, n6, OBJ_TREND, 0, open_time, tp, close_time, tp))
      {
         ObjectSetInteger(chart, n6, OBJPROP_COLOR, InpTargetColor);
         ObjectSetInteger(chart, n6, OBJPROP_STYLE, STYLE_DASH);
         ObjectSetInteger(chart, n6, OBJPROP_WIDTH, 1);
         ObjectSetInteger(chart, n6, OBJPROP_RAY_RIGHT, false);
         ObjectSetString(chart, n6, OBJPROP_TOOLTIP, "Take profit");
      }
   }
}

//+------------------------------------------------------------------+
//| JSON output                                                       |
//+------------------------------------------------------------------+
bool WriteTradeJson(ulong position_id, const string symbol, int direction, double volume,
                    datetime open_time, datetime close_time,
                    double entry_price, double exit_price, double sl, double tp,
                    double gross, double commission, double swap, double fee, double net,
                    double mae, double mfe, long magic, const string comment,
                    int digits, double point, const string screenshot)
{
   string path = StringFormat("%s\\trade_%I64u.json", g_spool, position_id);
   int fh = FileOpen(path, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE)
   {
      PrintFormat("[NotionJournal] Cannot write %s (error %d)", path, GetLastError());
      return(false);
   }

   int offset_min = (int)((TimeCurrent() - TimeGMT()) / 60);

   string j = "{\n";
   j += "  \"schema\": " + IntegerToString(SCHEMA_VER) + ",\n";
   j += "  \"type\": \"trade\",\n";
   j += "  \"emitted_at\": \"" + IsoTime(TimeCurrent()) + "\",\n";
   j += "  \"server_utc_offset_minutes\": " + IntegerToString(offset_min) + ",\n";
   j += "  \"account\": {\n";
   j += "    \"login\": " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ",\n";
   j += "    \"server\": \"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\",\n";
   j += "    \"company\": \"" + JsonEscape(AccountInfoString(ACCOUNT_COMPANY)) + "\",\n";
   j += "    \"currency\": \"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\",\n";
   j += "    \"balance\": " + Num(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",\n";
   j += "    \"equity\": " + Num(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "\n";
   j += "  },\n";
   j += "  \"trade\": {\n";
   j += "    \"position_id\": " + IntegerToString((long)position_id) + ",\n";
   j += "    \"symbol\": \"" + JsonEscape(symbol) + "\",\n";
   j += "    \"direction\": \"" + (direction > 0 ? "Long" : "Short") + "\",\n";
   j += "    \"volume\": " + Num(volume, 2) + ",\n";
   j += "    \"open_time\": \"" + IsoTime(open_time) + "\",\n";
   j += "    \"close_time\": \"" + IsoTime(close_time) + "\",\n";
   j += "    \"entry_price\": " + Num(entry_price, digits) + ",\n";
   j += "    \"exit_price\": " + Num(exit_price, digits) + ",\n";
   j += "    \"stop_loss\": " + Num(sl, digits) + ",\n";
   j += "    \"take_profit\": " + Num(tp, digits) + ",\n";
   j += "    \"gross_pl\": " + Num(gross, 2) + ",\n";
   j += "    \"commission\": " + Num(commission, 2) + ",\n";
   j += "    \"swap\": " + Num(swap, 2) + ",\n";
   j += "    \"fee\": " + Num(fee, 2) + ",\n";
   j += "    \"net_pl\": " + Num(net, 2) + ",\n";
   j += "    \"mae\": " + Num(mae, 2) + ",\n";
   j += "    \"mfe\": " + Num(mfe, 2) + ",\n";
   j += "    \"magic\": " + IntegerToString(magic) + ",\n";
   j += "    \"comment\": \"" + JsonEscape(comment) + "\",\n";
   j += "    \"digits\": " + IntegerToString(digits) + ",\n";
   j += "    \"point\": " + Num(point, 8) + ",\n";
   j += "    \"tick_size\": " + Num(SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE), 8) + ",\n";
   j += "    \"tick_value\": " + Num(SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE), 8) + ",\n";
   j += "    \"screenshot\": \"" + JsonEscape(screenshot) + "\"\n";
   j += "  }\n";
   j += "}\n";

   FileWriteString(fh, j);
   FileClose(fh);

   PrintFormat("[NotionJournal] Exported position %I64u (%s %s, net %.2f)",
               position_id, symbol, direction > 0 ? "long" : "short", net);
   return(true);
}

//+------------------------------------------------------------------+
void WriteAccountSnapshot()
{
   string path = g_spool + "\\account.json";
   int fh = FileOpen(path, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE)
      return;

   string j = "{\n";
   j += "  \"schema\": " + IntegerToString(SCHEMA_VER) + ",\n";
   j += "  \"type\": \"account\",\n";
   j += "  \"emitted_at\": \"" + IsoTime(TimeCurrent()) + "\",\n";
   j += "  \"login\": " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ",\n";
   j += "  \"server\": \"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\",\n";
   j += "  \"company\": \"" + JsonEscape(AccountInfoString(ACCOUNT_COMPANY)) + "\",\n";
   j += "  \"name\": \"" + JsonEscape(AccountInfoString(ACCOUNT_NAME)) + "\",\n";
   j += "  \"currency\": \"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\",\n";
   j += "  \"balance\": " + Num(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",\n";
   j += "  \"equity\": " + Num(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",\n";
   j += "  \"leverage\": " + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",\n";
   j += "  \"is_demo\": " + ((AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO) ? "true" : "false") + "\n";
   j += "}\n";

   FileWriteString(fh, j);
   FileClose(fh);
}

//+------------------------------------------------------------------+
//| Export closed positions from the recent past on first attach      |
//+------------------------------------------------------------------+
void Backfill()
{
   datetime from = TimeCurrent() - (datetime)InpBackfillDays * 86400;
   if(!HistorySelect(from, TimeCurrent()))
      return;

   ulong seen[];
   int deals = HistoryDealsTotal();
   int found = 0;

   for(int i = 0; i < deals; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0)
         continue;

      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY)
         continue;

      ulong pos = (ulong)HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      if(pos == 0 || AlreadyProcessed(pos))
         continue;

      bool dup = false;
      for(int k = 0; k < ArraySize(seen); k++)
         if(seen[k] == pos) { dup = true; break; }
      if(dup)
         continue;

      int n = ArraySize(seen);
      ArrayResize(seen, n + 1);
      seen[n] = pos;
      QueuePending(pos);
      found++;
   }

   if(found > 0)
      PrintFormat("[NotionJournal] Backfill queued %d position(s) from the last %d days",
                  found, InpBackfillDays);
}

//+------------------------------------------------------------------+
//| Pending queue helpers                                             |
//+------------------------------------------------------------------+
void QueuePending(ulong pos)
{
   for(int i = 0; i < ArraySize(g_pending); i++)
      if(g_pending[i] == pos)
         return;
   int n = ArraySize(g_pending);
   ArrayResize(g_pending, n + 1);
   g_pending[n] = pos;
}

void RemovePendingAt(int idx)
{
   int n = ArraySize(g_pending);
   for(int i = idx; i < n - 1; i++)
      g_pending[i] = g_pending[i + 1];
   ArrayResize(g_pending, n - 1);
}

//+------------------------------------------------------------------+
//| Processed-set persistence                                         |
//+------------------------------------------------------------------+
bool AlreadyProcessed(ulong pos)
{
   for(int i = 0; i < ArraySize(g_processed); i++)
      if(g_processed[i] == pos)
         return(true);
   return(false);
}

void MarkProcessed(ulong pos)
{
   int n = ArraySize(g_processed);
   ArrayResize(g_processed, n + 1);
   g_processed[n] = pos;

   int fh = FileOpen(g_spool + "\\" + STATE_FILE, FILE_READ | FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE)
      return;
   FileSeek(fh, 0, SEEK_END);
   FileWriteString(fh, IntegerToString((long)pos) + "\n");
   FileClose(fh);
}

void LoadProcessed()
{
   ArrayResize(g_processed, 0);
   string path = g_spool + "\\" + STATE_FILE;
   if(!FileIsExist(path))
      return;

   int fh = FileOpen(path, FILE_READ | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE)
      return;

   while(!FileIsEnding(fh))
   {
      string line = FileReadString(fh);
      StringTrimLeft(line);
      StringTrimRight(line);
      if(line == "")
         continue;
      ulong v = (ulong)StringToInteger(line);
      if(v == 0)
         continue;
      int n = ArraySize(g_processed);
      ArrayResize(g_processed, n + 1);
      g_processed[n] = v;
   }
   FileClose(fh);
   PrintFormat("[NotionJournal] Loaded %d previously exported position(s)", ArraySize(g_processed));
}

//+------------------------------------------------------------------+
//| Open-position snapshot persistence (survives terminal restarts)   |
//+------------------------------------------------------------------+
int FindOpenSnapshot(ulong pos)
{
   for(int i = 0; i < ArraySize(g_open); i++)
      if(g_open[i].position_id == pos)
         return(i);
   return(-1);
}

void DropOpenSnapshot(ulong pos)
{
   int idx = FindOpenSnapshot(pos);
   if(idx < 0)
      return;
   int n = ArraySize(g_open);
   for(int i = idx; i < n - 1; i++)
      g_open[i] = g_open[i + 1];
   ArrayResize(g_open, n - 1);
   SaveOpenSnapshots();
}

void SaveOpenSnapshots()
{
   int fh = FileOpen(g_spool + "\\" + OPEN_FILE, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE)
      return;
   for(int i = 0; i < ArraySize(g_open); i++)
   {
      FileWriteString(fh, StringFormat("%I64u,%.10f,%.10f,%.10f,%.10f,%.10f,%d\n",
                                       g_open[i].position_id,
                                       g_open[i].initial_sl, g_open[i].initial_tp,
                                       g_open[i].open_price,
                                       g_open[i].mae_price, g_open[i].mfe_price,
                                       g_open[i].direction));
   }
   FileClose(fh);
}

void LoadOpenSnapshots()
{
   ArrayResize(g_open, 0);
   string path = g_spool + "\\" + OPEN_FILE;
   if(!FileIsExist(path))
      return;

   int fh = FileOpen(path, FILE_READ | FILE_TXT | FILE_ANSI);
   if(fh == INVALID_HANDLE)
      return;

   while(!FileIsEnding(fh))
   {
      string line = FileReadString(fh);
      StringTrimLeft(line);
      StringTrimRight(line);
      if(line == "")
         continue;

      string parts[];
      if(StringSplit(line, ',', parts) != 7)
         continue;

      OpenSnapshot s;
      s.position_id = (ulong)StringToInteger(parts[0]);
      s.initial_sl  = StringToDouble(parts[1]);
      s.initial_tp  = StringToDouble(parts[2]);
      s.open_price  = StringToDouble(parts[3]);
      s.mae_price   = StringToDouble(parts[4]);
      s.mfe_price   = StringToDouble(parts[5]);
      s.direction   = (int)StringToInteger(parts[6]);

      int n = ArraySize(g_open);
      ArrayResize(g_open, n + 1);
      g_open[n] = s;
   }
   FileClose(fh);
}

//+------------------------------------------------------------------+
//| Formatting helpers                                                |
//+------------------------------------------------------------------+
string IsoTime(datetime t)
{
   MqlDateTime d;
   TimeToStruct(t, d);
   return(StringFormat("%04d-%02d-%02dT%02d:%02d:%02d",
                       d.year, d.mon, d.day, d.hour, d.min, d.sec));
}

string Num(double v, int digits)
{
   if(!MathIsValidNumber(v))
      return("0");
   return(DoubleToString(v, digits));
}

string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", "\\n");
   StringReplace(s, "\r", "\\r");
   StringReplace(s, "\t", "\\t");
   return(s);
}
//+------------------------------------------------------------------+
