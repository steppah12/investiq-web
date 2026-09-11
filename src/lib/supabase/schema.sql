-- InvestIQ Supabase Schema
-- Run this in your Supabase SQL Editor

-- Enable Row Level Security
ALTER DATABASE postgres SET "app.jwt_secret" TO 'your-jwt-secret';

-- Create stocks table
CREATE TABLE IF NOT EXISTS stocks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  ticker TEXT,
  data JSONB NOT NULL DEFAULT '[]',
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create model weights table
CREATE TABLE IF NOT EXISTS model_weights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stock_name TEXT NOT NULL,
  horizon INTEGER NOT NULL,
  weights JSONB NOT NULL,
  accuracy REAL,
  version TEXT DEFAULT '9.5.31',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(stock_name, horizon)
);

-- Create training results table
CREATE TABLE IF NOT EXISTS training_results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stock_name TEXT NOT NULL,
  result_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create predictions table
CREATE TABLE IF NOT EXISTS predictions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stock_name TEXT NOT NULL,
  date DATE NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN', 'NEUTRAL')),
  confidence REAL NOT NULL,
  predicted_return REAL,
  actual_return REAL,
  correct BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(stock_name, date)
);

-- Create portfolio table
CREATE TABLE IF NOT EXISTS portfolio (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID, -- For multi-user support later
  asset TEXT NOT NULL,
  quantity REAL NOT NULL,
  buy_price REAL NOT NULL,
  current_price REAL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create audit log table
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create macro data table
CREATE TABLE IF NOT EXISTS macro_data (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  cbk_rate REAL,
  inflation REAL,
  usd_kes REAL,
  gdp_growth REAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create NSE data fetching log
CREATE TABLE IF NOT EXISTS nse_fetch_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stock_ticker TEXT NOT NULL,
  fetch_date DATE NOT NULL,
  status TEXT NOT NULL,
  price_data JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_stocks_name ON stocks(name);
CREATE INDEX IF NOT EXISTS idx_model_weights_stock ON model_weights(stock_name);
CREATE INDEX IF NOT EXISTS idx_training_results_stock ON training_results(stock_name);
CREATE INDEX IF NOT EXISTS idx_predictions_stock_date ON predictions(stock_name, date);
CREATE INDEX IF NOT EXISTS idx_portfolio_asset ON portfolio(asset);
CREATE INDEX IF NOT EXISTS idx_macro_data_date ON macro_data(date);
CREATE INDEX IF NOT EXISTS idx_nse_fetch_log_ticker_date ON nse_fetch_log(stock_ticker, fetch_date);

-- Enable Row Level Security (RLS)
ALTER TABLE stocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE macro_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE nse_fetch_log ENABLE ROW LEVEL SECURITY;

-- Create RLS policies (allow all for now, restrict later for multi-user)
CREATE POLICY "Allow all operations" ON stocks FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON model_weights FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON training_results FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON predictions FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON portfolio FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON audit_log FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON macro_data FOR ALL USING (true);
CREATE POLICY "Allow all operations" ON nse_fetch_log FOR ALL USING (true);

-- Create a function to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_portfolio_updated_at BEFORE UPDATE ON portfolio
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();