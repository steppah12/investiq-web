#!/usr/bin/env node

/**
 * Database Setup Script for InvestIQ
 * 
 * This script helps initialize the Supabase database with the correct schema.
 * Run: node scripts/setup-db.js
 */

const fs = require('fs');
const path = require('path');

async function setupDatabase() {
  console.log('🚀 InvestIQ Database Setup\n');

  // Check for environment variables
  const requiredEnvs = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY', 
    'SUPABASE_SERVICE_ROLE_KEY'
  ];

  console.log('📋 Checking environment variables...');
  const envPath = path.join(__dirname, '..', '.env.local');
  
  if (!fs.existsSync(envPath)) {
    console.log('❌ .env.local not found');
    console.log('   Copy .env.local.example to .env.local and fill in your Supabase credentials\n');
    
    console.log('📝 Steps to get Supabase credentials:');
    console.log('   1. Go to https://supabase.com and create a new project');
    console.log('   2. Go to Settings > API in your Supabase dashboard');
    console.log('   3. Copy the Project URL and anon public key');
    console.log('   4. Copy the service_role secret key (keep this secure!)');
    console.log('   5. Paste them into .env.local\n');
    
    return;
  }

  // Load environment variables
  require('dotenv').config({ path: envPath });
  
  let missingEnvs = [];
  for (const env of requiredEnvs) {
    if (!process.env[env]) {
      missingEnvs.push(env);
    }
  }
  
  if (missingEnvs.length > 0) {
    console.log('❌ Missing environment variables:');
    missingEnvs.forEach(env => console.log(`   - ${env}`));
    console.log('\n   Please add them to .env.local\n');
    return;
  }

  console.log('✅ Environment variables found\n');

  // Read SQL schema
  console.log('📖 Reading database schema...');
  const schemaPath = path.join(__dirname, '..', 'src', 'lib', 'supabase', 'schema.sql');
  
  if (!fs.existsSync(schemaPath)) {
    console.log('❌ Schema file not found at:', schemaPath);
    return;
  }

  const schema = fs.readFileSync(schemaPath, 'utf8');
  console.log('✅ Schema loaded\n');

  // Test connection
  console.log('🔗 Testing Supabase connection...');
  
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Test with a simple query
    const { data, error } = await supabase.from('stocks').select('count');
    
    if (error && !error.message.includes('relation "stocks" does not exist')) {
      throw error;
    }

    console.log('✅ Connected to Supabase\n');

    // Display next steps
    console.log('📋 Next Steps:');
    console.log('   1. Go to your Supabase project dashboard');
    console.log('   2. Navigate to SQL Editor');
    console.log('   3. Create a new query');
    console.log('   4. Copy and paste the schema from: src/lib/supabase/schema.sql');
    console.log('   5. Run the SQL query to create all tables and policies');
    console.log('   6. Come back and run: npm run dev\n');

    console.log('🎯 Schema Preview:');
    console.log('   - stocks table (store NSE stock data)');
    console.log('   - model_weights table (ML model storage)'); 
    console.log('   - training_results table (backtest results)');
    console.log('   - predictions table (live predictions)');
    console.log('   - portfolio table (investment tracking)');
    console.log('   - audit_log table (system events)');
    console.log('   - macro_data table (CBK rates, inflation)');
    console.log('   - nse_fetch_log table (data fetching status)\n');

    console.log('⚡ Ready to launch InvestIQ!');
    console.log('   After running the schema, start with: npm run dev\n');

  } catch (error) {
    console.log('❌ Connection failed:', error.message);
    console.log('   Please check your Supabase URL and keys\n');
  }
}

// Run the setup
setupDatabase().catch(console.error);