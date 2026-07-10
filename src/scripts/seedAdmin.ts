import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import User from '../models/user';
import connectDB from '../config/db';

const seedAdmin = async () => {
  try {
    console.log('🌱 Starting admin seed process...');

    // Connect to database
    await connectDB();
    console.log('✅ Connected to database');

    // Check if admin already exists
    const existingAdmin = await User.findOne({ role: 'admin' });
    
    if (existingAdmin) {
      console.log('⚠️ Admin user already exists:');
      console.log(`   Email: ${existingAdmin.email}`);
      console.log(`   Name: ${existingAdmin.name}`);
      console.log('   Use this account to login to admin panel');
      process.exit(0);
    }

    // Admin user data
    const adminData = {
      name: 'Fixtract Admin',
      email: 'admin@fixtract.com',
      phone: '+1234567890',
      password: 'admin123456', // Will be hashed
      role: 'admin',
      isEmailVerified: true,
      isPhoneVerified: true
    };

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(adminData.password, saltRounds);

    // Create admin user
    const admin = new User({
      ...adminData,
      password: hashedPassword
    });

    await admin.save();

    console.log('🎉 Admin user created successfully!');
    console.log('');
    console.log('📋 Admin Login Credentials:');
    console.log('   Email: admin@fixtract.com');
    console.log('   Password: admin123456');
    console.log('');
    console.log('🔒 IMPORTANT: Change the password after first login!');
    console.log('');
    console.log('🚀 Admin can now access:');
    console.log('   • Professional approvals');
    console.log('   • Loyalty system configuration');
    console.log('   • System analytics');
    console.log('');

    // Also create loyalty configuration if it doesn't exist
    const LoyaltyConfig = (await import('../models/loyaltyConfig')).default;
    await LoyaltyConfig.getCurrentConfig();
    console.log('✅ Loyalty system initialized with default configuration');

    process.exit(0);

  } catch (error) {
    console.error('❌ Error creating admin user:', error);
    process.exit(1);
  }
};

// Run if called directly
if (require.main === module) {
  seedAdmin();
}

export default seedAdmin;