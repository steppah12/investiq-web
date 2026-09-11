# InvestIQ Deployment Guide

## Option 1: Vercel (Recommended - Easiest)

### Prerequisites
1. GitHub account
2. Supabase project set up
3. Code pushed to GitHub repository

### Steps

1. **Create Supabase Project**
   - Go to [supabase.com](https://supabase.com)
   - Create new project
   - Wait for setup to complete (~2 minutes)

2. **Run Database Schema**
   - Go to SQL Editor in Supabase dashboard
   - Copy contents from `src/lib/supabase/schema.sql`
   - Paste and run the SQL query
   - Verify tables are created

3. **Deploy to Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Click "Import Project"
   - Select your GitHub repository
   - Click "Deploy"

4. **Add Environment Variables**
   - In Vercel dashboard, go to Settings > Environment Variables
   - Add these variables:
     ```
     NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
     NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
     SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
     ```
   - Get these values from Supabase Settings > API

5. **Redeploy**
   - Go to Deployments tab in Vercel
   - Click "Redeploy" to pick up environment variables

6. **Test the Application**
   - Visit your Vercel URL
   - Upload a test CSV file
   - Verify data is stored in Supabase

## Option 2: Railway

### Steps

1. **Setup Database** (same as Vercel steps 1-2)

2. **Deploy to Railway**
   - Go to [railway.app](https://railway.app)
   - Click "Deploy from GitHub repo"
   - Select your repository
   - Railway will auto-detect Next.js

3. **Add Environment Variables**
   - In Railway dashboard, go to Variables tab
   - Add the same environment variables as above

4. **Custom Domain** (Optional)
   - Go to Settings > Domains
   - Add your custom domain

## Option 3: Digital Ocean App Platform

### Steps

1. **Setup Database** (same as above)

2. **Deploy to DO Apps**
   - Go to Digital Ocean control panel
   - Create new App
   - Connect GitHub repository
   - Select "Web Service" type

3. **Configure Build Settings**
   - Build Command: `npm run build`
   - Run Command: `npm start`
   - Environment: Node.js

4. **Add Environment Variables**
   - In App settings, add environment variables
   - Same variables as above

## Option 4: Self-Hosted (VPS)

### Prerequisites
- Ubuntu 20.04+ server
- Node.js 18+
- PM2 for process management
- Nginx for reverse proxy

### Steps

1. **Server Setup**
   ```bash
   # Update system
   sudo apt update && sudo apt upgrade -y
   
   # Install Node.js 18
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   
   # Install PM2
   sudo npm install -g pm2
   
   # Install Nginx
   sudo apt install nginx -y
   ```

2. **Deploy Application**
   ```bash
   # Clone repository
   git clone https://github.com/yourusername/investiq-web.git
   cd investiq-web
   
   # Install dependencies
   npm install
   
   # Create environment file
   cp .env.local.example .env.local
   # Edit .env.local with your Supabase credentials
   
   # Build application
   npm run build
   
   # Start with PM2
   pm2 start npm --name "investiq" -- start
   pm2 save
   pm2 startup
   ```

3. **Configure Nginx**
   ```nginx
   # /etc/nginx/sites-available/investiq
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

4. **Enable Site**
   ```bash
   sudo ln -s /etc/nginx/sites-available/investiq /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

5. **SSL Certificate** (Optional but recommended)
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```

## Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL | `https://abc123.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key | `eyJ...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | `eyJ...` |

## Post-Deployment Checklist

- [ ] Database schema is properly created
- [ ] Environment variables are set correctly
- [ ] Application loads without errors
- [ ] File upload works
- [ ] Data is stored in Supabase
- [ ] SSL certificate is active (production)
- [ ] Custom domain configured (if applicable)

## Monitoring & Maintenance

### Vercel
- Built-in analytics and monitoring
- Automatic deployments on git push
- Edge functions for optimal performance

### Self-Hosted
- Use PM2 for process monitoring: `pm2 monit`
- Set up log rotation: `pm2 install pm2-logrotate`
- Monitor with: `htop`, `df -h`, `free -h`

## Troubleshooting

### Database Connection Issues
```bash
# Test connection locally
node -e "
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
supabase.from('stocks').select('count').then(console.log);
"
```

### Build Failures
- Check Node.js version: `node --version` (should be 18+)
- Clear cache: `rm -rf .next node_modules && npm install`
- Check TypeScript errors: `npm run type-check`

### Performance Issues
- Enable Vercel Edge Functions
- Use Supabase connection pooling
- Implement Redis caching for frequent queries
- Optimize images with Next.js Image component

## Scaling Considerations

### Database
- Enable Supabase connection pooling
- Set up read replicas for analytics queries
- Implement proper indexing for large datasets

### Application
- Use Next.js static generation where possible
- Implement proper caching strategies
- Consider CDN for static assets
- Monitor bundle size and optimize

### NSE Data Fetching
- Implement rate limiting
- Use queue system for bulk operations
- Set up monitoring and alerting
- Consider backup data sources