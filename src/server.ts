import * as dotenv from 'dotenv';
dotenv.config();

import app from './app';

const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, () => {
  const hasFirebase = process.env.FIREBASE_PROJECT_ID &&
    !process.env.FIREBASE_PRIVATE_KEY?.includes('YOUR_PRIVATE_KEY');
  const hasRazorpay = process.env.RAZORPAY_KEY_ID &&
    !process.env.RAZORPAY_KEY_ID?.includes('XXXX');

  console.log(`\n🚀 LoadLink running at http://localhost:${PORT}`);
  console.log(`   Firebase : ${hasFirebase ? '✅ configured' : '⚠️  NOT configured — update .env'}`);
  console.log(`   Razorpay : ${hasRazorpay ? '✅ configured' : '⚠️  NOT configured — update .env'}`);
  if (!hasFirebase || !hasRazorpay) {
    console.log('\n   📋 Setup guide: open .env and fill in the credentials');
    console.log('   Firebase → https://console.firebase.google.com → Project Settings → Service Accounts');
    console.log('   Razorpay → https://dashboard.razorpay.com → Settings → API Keys\n');
  }
});
