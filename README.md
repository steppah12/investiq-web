# InvestIQ Web - NSE Stock ML Platform

A Next.js web application for machine learning analysis of Nairobi Securities Exchange (NSE) stocks.

## Quick Setup Guide

### 1. Database Setup (Supabase)

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run the schema from `src/lib/supabase/schema.sql`
3. Copy your project URL and anon key from Settings > API

### 2. Environment Variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local` with your Supabase credentials:

```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application.

## Features

- **Data Management**: Upload NSE stock CSV files with robust parsing
- **ML Training**: Ensemble models (LogReg + GBDT) with walk-forward validation  
- **Real-time Predictions**: Generate stock predictions with confidence scoring
- **Backtesting**: Historical performance analysis
- **Live Lab**: Real-time model testing and journaling
- **Portfolio Tracking**: Investment performance monitoring

## Data Sources

- NSE website exports
- Yahoo Finance CSV
- Custom CSV formats with Date/Close columns

## ML Pipeline

- **Features**: 11 core technical indicators after ablation study
- **Labels**: 3-class UP/FLAT/DOWN with auto-calibrated deadbands
- **Models**: LogReg (25%) + GBDT (45%) + Pattern (30%) ensemble
- **Validation**: Walk-forward with corporate action detection
- **OOD Detection**: Prevents predictions during regime changes

## Deployment

### Vercel (Recommended)

1. Push code to GitHub
2. Connect repository to Vercel
3. Add environment variables in Vercel dashboard
4. Deploy automatically

### Manual Deployment

```bash
npm run build
npm run start
```

## Architecture

```
investiq-web/
├── src/
│   ├── app/                 # Next.js app router
│   ├── components/tabs/     # Tab components
│   ├── lib/
│   │   ├── supabase/       # Database client & schema
│   │   ├── ml/             # ML utilities (indicators, features)
│   │   └── database.ts     # Database abstraction
│   └── types/              # TypeScript definitions
├── package.json
└── README.md
```

## Migration from localStorage

The app automatically migrates from the original localStorage-based system to Supabase. All existing data structures are preserved.

## NSE Stocks Supported

Pre-configured for 65+ NSE stocks including:
- Banking: KCB, Equity, Safaricom, Co-op, Stanbic, NCBA, I&M, Absa
- Manufacturing: EABL, BAT Kenya, Bamburi Cement  
- Energy: Total Energies, Kengen, Kenya Power
- Insurance: Jubilee, Britam, CIC
- And many more...

## Troubleshooting

### Database Connection Issues
- Verify Supabase URL and keys in `.env.local`
- Check if RLS policies are properly set
- Ensure schema was run successfully

### CSV Upload Problems  
- Files must have Date and Close/Price columns
- Dates should be in YYYY-MM-DD or DD/MM/YYYY format
- Minimum 10 rows required after cleaning

### Training Failures
- Ensure >200 rows for reliable training
- Check for corporate actions in data
- Verify feature engineering completed

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

Private project for NSE investment analysis.