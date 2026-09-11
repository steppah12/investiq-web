# InvestIQ - Quick Start Guide

## 🚀 Deploy in 10 Minutes

### Step 1: Initialize Git Repository
```bash
cd investiq-web
git init
git add .
git commit -m "Initial InvestIQ deployment"
```

### Step 2: Push to GitHub
```bash
# Create a new repository on GitHub first, then:
git remote add origin https://github.com/yourusername/investiq-web.git
git branch -M main
git push -u origin main
```

### Step 3: Create Supabase Project
1. Go to [supabase.com](https://supabase.com)
2. Click "New Project"
3. Choose organization and enter project details
4. Wait 2-3 minutes for setup
5. Go to SQL Editor
6. Copy/paste contents from `src/lib/supabase/schema.sql`
7. Click "Run" to create all tables

### Step 4: Deploy to Vercel
1. Go to [vercel.com](https://vercel.com)
2. Click "New Project"
3. Import your GitHub repository
4. Framework will auto-detect as Next.js
5. Click "Deploy" (first deployment will fail - that's expected)

### Step 5: Add Environment Variables
1. In Vercel dashboard, go to Settings > Environment Variables
2. Add these 4 variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_key  
CRON_SECRET=any-random-string-for-security
```

Get Supabase keys from: Settings > API in your Supabase dashboard

### Step 6: Redeploy
1. Go to Deployments tab in Vercel
2. Click "Redeploy" on the latest deployment
3. Wait 2-3 minutes
4. Your app should now be live! 🎉

### Step 7: Test Your Deployment
1. Visit your Vercel URL (e.g. `investiq-web.vercel.app`)
2. You should see the InvestIQ interface
3. Try uploading a test CSV file
4. Check if data appears in Supabase dashboard

## 📊 Sample NSE Data

Create a test CSV file with this content:

```csv
Date,Close
2024-01-01,15.50
2024-01-02,15.75
2024-01-03,15.60
2024-01-04,15.90
2024-01-05,16.10
```

Save as `safaricom_test.csv` and upload to test the system.

## 🔧 Troubleshooting

### Build Errors
- Check Node.js version: `node --version` (need 18+)
- Clear cache: `rm -rf .next node_modules && npm install`

### Database Connection Issues
- Verify environment variables are set correctly
- Check Supabase project is not paused
- Ensure schema was run successfully

### Upload Issues
- CSV must have Date and Close columns
- Dates should be YYYY-MM-DD format
- Files must be .csv or .txt extension

## 🎯 Next Steps

After successful deployment:

1. **Upload Your NSE Data**: Add your real stock CSV files
2. **Configure Auto-Fetch**: Set up daily NSE data updates
3. **Train Models**: Start with stocks that have 500+ rows
4. **Monitor Performance**: Use the Live Lab for testing
5. **Scale Up**: Add more NSE stocks as needed

## 🏆 Success Metrics

Your deployment is successful when:
- ✅ App loads without errors
- ✅ File upload works
- ✅ Data appears in Supabase tables
- ✅ No console errors in browser
- ✅ All tabs are accessible

## 📞 Support

If you encounter issues:
1. Check browser console for errors
2. Review Vercel deployment logs
3. Verify Supabase connection in SQL Editor
4. Test with sample data first

**Congratulations! You now have a production-ready NSE ML platform! 🚀**