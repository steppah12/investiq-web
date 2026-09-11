#!/usr/bin/env node

/**
 * InvestIQ Deployment Validation Script
 * 
 * Validates that the deployment is ready for production
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 InvestIQ Deployment Validation');
console.log('==================================\n');

let errors = 0;
let warnings = 0;

function logError(message) {
  console.log(`❌ ERROR: ${message}`);
  errors++;
}

function logWarning(message) {
  console.log(`⚠️  WARNING: ${message}`);
  warnings++;
}

function logSuccess(message) {
  console.log(`✅ ${message}`);
}

// Check file structure
function validateFileStructure() {
  console.log('📁 Checking file structure...');
  
  const requiredFiles = [
    'package.json',
    'next.config.js',
    'tsconfig.json',
    'tailwind.config.js',
    'src/app/page.tsx',
    'src/lib/database.ts',
    'src/lib/supabase/schema.sql',
    'src/types/index.ts'
  ];
  
  for (const file of requiredFiles) {
    if (fs.existsSync(file)) {
      logSuccess(`Found ${file}`);
    } else {
      logError(`Missing required file: ${file}`);
    }
  }
  
  console.log('');
}

// Check package.json
function validatePackageJson() {
  console.log('📦 Checking package.json...');
  
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    
    if (pkg.name === 'investiq-web') {
      logSuccess('Package name is correct');
    } else {
      logWarning(`Package name is "${pkg.name}", expected "investiq-web"`);
    }
    
    const requiredScripts = ['dev', 'build', 'start', 'test'];
    for (const script of requiredScripts) {
      if (pkg.scripts[script]) {
        logSuccess(`Script "${script}" is defined`);
      } else {
        logError(`Missing script: ${script}`);
      }
    }
    
    const requiredDeps = ['next', 'react', '@supabase/supabase-js', 'typescript'];
    for (const dep of requiredDeps) {
      if (pkg.dependencies[dep]) {
        logSuccess(`Dependency "${dep}" is installed`);
      } else {
        logError(`Missing dependency: ${dep}`);
      }
    }
    
  } catch (error) {
    logError(`Failed to parse package.json: ${error.message}`);
  }
  
  console.log('');
}

// Check environment variables
function validateEnvironment() {
  console.log('🔧 Checking environment configuration...');
  
  if (fs.existsSync('.env.local.example')) {
    logSuccess('Environment example file exists');
    
    const envExample = fs.readFileSync('.env.local.example', 'utf8');
    const requiredVars = [
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY'
    ];
    
    for (const varName of requiredVars) {
      if (envExample.includes(varName)) {
        logSuccess(`Environment variable ${varName} is documented`);
      } else {
        logError(`Missing environment variable documentation: ${varName}`);
      }
    }
  } else {
    logError('Missing .env.local.example file');
  }
  
  if (fs.existsSync('.env.local')) {
    logWarning('.env.local exists (ensure it\'s not committed to git)');
  } else {
    logSuccess('No .env.local file (good for deployment)');
  }
  
  console.log('');
}

// Check TypeScript configuration
function validateTypeScript() {
  console.log('🔷 Checking TypeScript configuration...');
  
  try {
    const tsconfig = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
    
    if (tsconfig.compilerOptions.strict) {
      logSuccess('TypeScript strict mode is enabled');
    } else {
      logWarning('TypeScript strict mode is disabled');
    }
    
    if (tsconfig.compilerOptions.target) {
      logSuccess(`TypeScript target: ${tsconfig.compilerOptions.target}`);
    } else {
      logWarning('No TypeScript target specified');
    }
    
  } catch (error) {
    logError(`Failed to parse tsconfig.json: ${error.message}`);
  }
  
  console.log('');
}

// Check sample data
function validateSampleData() {
  console.log('📊 Checking sample data...');
  
  const sampleDir = 'sample-data';
  if (fs.existsSync(sampleDir)) {
    const files = fs.readdirSync(sampleDir);
    const csvFiles = files.filter(f => f.endsWith('.csv'));
    
    logSuccess(`Found ${csvFiles.length} sample CSV files`);
    
    for (const file of csvFiles) {
      const content = fs.readFileSync(path.join(sampleDir, file), 'utf8');
      const lines = content.split('\n');
      
      if (lines.length > 10) {
        logSuccess(`${file} has sufficient data (${lines.length} lines)`);
      } else {
        logWarning(`${file} has limited data (${lines.length} lines)`);
      }
    }
  } else {
    logWarning('No sample-data directory found');
  }
  
  console.log('');
}

// Check deployment configuration
function validateDeployment() {
  console.log('🚀 Checking deployment configuration...');
  
  if (fs.existsSync('vercel.json')) {
    logSuccess('Vercel configuration exists');
    
    try {
      const vercelConfig = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
      
      if (vercelConfig.crons && vercelConfig.crons.length > 0) {
        logSuccess('Cron jobs are configured');
      } else {
        logWarning('No cron jobs configured');
      }
      
    } catch (error) {
      logError(`Failed to parse vercel.json: ${error.message}`);
    }
  } else {
    logWarning('No Vercel configuration found');
  }
  
  const deploymentFiles = ['DEPLOYMENT.md', 'QUICK_START.md', 'README.md'];
  for (const file of deploymentFiles) {
    if (fs.existsSync(file)) {
      logSuccess(`Documentation file exists: ${file}`);
    } else {
      logWarning(`Missing documentation: ${file}`);
    }
  }
  
  console.log('');
}

// Check database schema
function validateDatabase() {
  console.log('🗄️ Checking database schema...');
  
  const schemaPath = 'src/lib/supabase/schema.sql';
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    const requiredTables = [
      'stocks',
      'model_weights',
      'training_results',
      'predictions',
      'portfolio'
    ];
    
    for (const table of requiredTables) {
      if (schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) {
        logSuccess(`Table "${table}" is defined in schema`);
      } else {
        logError(`Missing table definition: ${table}`);
      }
    }
    
    if (schema.includes('ROW LEVEL SECURITY')) {
      logSuccess('Row Level Security is configured');
    } else {
      logWarning('No Row Level Security found in schema');
    }
    
  } else {
    logError('Database schema file not found');
  }
  
  console.log('');
}

// Run all validations
function runValidation() {
  validateFileStructure();
  validatePackageJson();
  validateEnvironment();
  validateTypeScript();
  validateSampleData();
  validateDeployment();
  validateDatabase();
  
  console.log('==================================');
  console.log(`📊 Validation Summary:`);
  console.log(`   Errors: ${errors}`);
  console.log(`   Warnings: ${warnings}`);
  console.log('');
  
  if (errors === 0) {
    console.log('🎉 Validation passed! InvestIQ is ready for deployment.');
    console.log('');
    console.log('Next steps:');
    console.log('1. Follow QUICK_START.md for rapid deployment');
    console.log('2. Set up your Supabase database');
    console.log('3. Deploy to Vercel');
    console.log('4. Test with sample data');
    console.log('');
    return true;
  } else {
    console.log('❌ Validation failed. Please fix the errors above.');
    console.log('');
    return false;
  }
}

// Run validation
const success = runValidation();
process.exit(success ? 0 : 1);