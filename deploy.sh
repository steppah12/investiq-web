#!/bin/bash

# InvestIQ Deployment Script
echo "🚀 Deploying InvestIQ to Vercel..."

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run from the project root."
    exit 1
fi

# Check if Vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "📦 Installing Vercel CLI..."
    npm install -g vercel
fi

# Build and type check locally first
echo "🔨 Building project locally..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed. Please fix errors before deploying."
    exit 1
fi

echo "✅ Local build successful"

# Type check
echo "🔍 Running type check..."
npm run type-check

if [ $? -ne 0 ]; then
    echo "❌ Type check failed. Please fix TypeScript errors."
    exit 1
fi

echo "✅ Type check passed"

# Deploy to Vercel
echo "🌐 Deploying to Vercel..."
vercel --prod

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "1. Set up your Supabase database (see DEPLOYMENT.md)"
echo "2. Add environment variables in Vercel dashboard"
echo "3. Test the application"
echo "4. Set up your custom domain (optional)"
echo ""
echo "🔗 Useful links:"
echo "- Vercel Dashboard: https://vercel.com/dashboard"
echo "- Supabase Dashboard: https://supabase.com/dashboard"
echo "- Project Documentation: README.md"