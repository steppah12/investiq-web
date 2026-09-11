#!/bin/bash

# InvestIQ Project Initialization Script
echo "🎯 InvestIQ - Initializing Your NSE ML Platform..."
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if git is initialized
if [ ! -d ".git" ]; then
    echo -e "${BLUE}📦 Initializing Git repository...${NC}"
    git init
    echo "# InvestIQ - NSE Stock ML Platform" > README.md
    echo "" >> README.md
    echo "Machine Learning Investment Analysis Platform for Nairobi Securities Exchange (NSE)" >> README.md
    git add .
    git commit -m "Initial commit: InvestIQ NSE ML Platform v9.5.31"
    echo -e "${GREEN}✅ Git repository initialized${NC}"
else
    echo -e "${GREEN}✅ Git repository already exists${NC}"
fi

echo ""
echo -e "${YELLOW}📋 Next Steps:${NC}"
echo ""
echo "1. 🌐 Push to GitHub:"
echo "   - Create a new repository at https://github.com"
echo "   - Run: git remote add origin https://github.com/username/investiq-web.git"
echo "   - Run: git branch -M main"
echo "   - Run: git push -u origin main"
echo ""

echo "2. 🗄️  Set up Supabase:"
echo "   - Go to https://supabase.com"
echo "   - Create new project"
echo "   - Run SQL from: src/lib/supabase/schema.sql"
echo ""

echo "3. 🚀 Deploy to Vercel:"
echo "   - Go to https://vercel.com"
echo "   - Import your GitHub repository"
echo "   - Add environment variables (see .env.local.example)"
echo ""

echo "4. 📊 Test with NSE data:"
echo "   - Upload CSV files with Date,Close columns"
echo "   - Verify data appears in Supabase"
echo ""

echo -e "${GREEN}🎉 Project ready for deployment!${NC}"
echo ""
echo "📖 For detailed instructions, see:"
echo "   - QUICK_START.md (10-minute setup)"
echo "   - DEPLOYMENT.md (comprehensive guide)"
echo "   - README.md (feature overview)"
echo ""

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}🔧 Installing dependencies...${NC}"
    npm install
    echo -e "${GREEN}✅ Dependencies installed${NC}"
fi

echo -e "${BLUE}🔍 Running project health check...${NC}"

# Check Node.js version
NODE_VERSION=$(node --version)
echo "Node.js version: $NODE_VERSION"

# Check if TypeScript compiles
npm run type-check > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ TypeScript compilation successful${NC}"
else
    echo -e "${RED}❌ TypeScript errors found - check with: npm run type-check${NC}"
fi

# Try building
npm run build > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Build successful${NC}"
else
    echo -e "${RED}❌ Build failed - check with: npm run build${NC}"
fi

echo ""
echo -e "${GREEN}🎯 InvestIQ is ready! Follow the next steps above to deploy.${NC}"