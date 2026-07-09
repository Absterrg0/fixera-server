const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

// Database connection
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/fixtract');
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('Database connection error:', error);
    process.exit(1);
  }
};

// User schema (simplified for seeding)
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'visitor', 'customer', 'professional'], default: 'customer' },
  isEmailVerified: { type: Boolean, default: false },
  isPhoneVerified: { type: Boolean, default: false }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

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

    process.exit(0);

  } catch (error) {
    console.error('❌ Error creating admin user:', error);
    process.exit(1);
  }
};

// Run the seed
seedAdmin();