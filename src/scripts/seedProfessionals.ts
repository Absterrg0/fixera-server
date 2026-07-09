import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import User from '../models/user';
import connectDB from '../config/db';

const seedProfessionals = async () => {
  try {
    console.log('🌱 Starting professionals seed process...');

    // Connect to database
    await connectDB();
    console.log('✅ Connected to database');

    // Delete existing professionals
    const existingProfessionals = await User.countDocuments({ role: 'professional' });

    if (existingProfessionals > 0) {
      console.log(`🗑️  Found ${existingProfessionals} existing professionals`);
      const deleteResult = await User.deleteMany({ role: 'professional' });
      console.log(`✅ Deleted ${deleteResult.deletedCount} existing professionals`);
    }

    // Hash a common password for all seed professionals
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash('professional123', saltRounds);

    // Sample professional data with various categories
    const professionalsData = [
      {
        name: 'Marcus Janssen',
        email: 'marcus.janssen@fixtract.test',
        phone: '+32471234501',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 45,
        currency: 'EUR',
        serviceCategories: ['exterior', 'interior'],
        businessInfo: {
          companyName: 'Janssen Electrical & Plumbing',
          description: 'Expert electrical and plumbing services with over 15 years of experience. Certified and insured.',
          city: 'Brussels',
          country: 'Belgium',
          postalCode: '1000',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Sophie Dubois',
        email: 'sophie.dubois@fixtract.test',
        phone: '+32471234502',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 65,
        currency: 'EUR',
        serviceCategories: ['interior'],
        businessInfo: {
          companyName: 'Dubois Interior Design',
          description: 'Award-winning interior designer specializing in modern and minimalist spaces. Complete design and renovation services.',
          city: 'Antwerp',
          country: 'Belgium',
          postalCode: '2000',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Lars Van Der Berg',
        email: 'lars.vandeberg@fixtract.test',
        phone: '+31612345601',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 55,
        currency: 'EUR',
        serviceCategories: ['outdoor-work', 'exterior'],
        businessInfo: {
          companyName: 'Van Der Berg Landscaping',
          description: 'Professional landscaping and outdoor construction. Creating beautiful gardens and outdoor living spaces.',
          city: 'Amsterdam',
          country: 'Netherlands',
          postalCode: '1012',
          timezone: 'Europe/Amsterdam'
        }
      },
      {
        name: 'Elena Martinez',
        email: 'elena.martinez@fixtract.test',
        phone: '+32471234503',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 50,
        currency: 'EUR',
        serviceCategories: ['interior'],
        businessInfo: {
          companyName: 'Martinez Painting & Finishing',
          description: 'High-quality painting and finishing work for residential and commercial properties. Attention to detail guaranteed.',
          city: 'Ghent',
          country: 'Belgium',
          postalCode: '9000',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Thomas Schneider',
        email: 'thomas.schneider@fixtract.test',
        phone: '+32471234504',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 70,
        currency: 'EUR',
        serviceCategories: ['exterior', 'interior'],
        businessInfo: {
          companyName: 'Schneider Solar Solutions',
          description: 'Specialized in solar panel installation and sustainable energy solutions. Certified solar installer with 300+ installations.',
          city: 'Brussels',
          country: 'Belgium',
          postalCode: '1050',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Isabella Rossi',
        email: 'isabella.rossi@fixtract.test',
        phone: '+32471234505',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 80,
        currency: 'EUR',
        serviceCategories: ['interior', 'exterior'],
        businessInfo: {
          companyName: 'Rossi Architectural Design',
          description: 'Boutique architectural firm specializing in residential renovations and modern design. Creating spaces that inspire.',
          city: 'Leuven',
          country: 'Belgium',
          postalCode: '3000',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Pieter Vermeer',
        email: 'pieter.vermeer@fixtract.test',
        phone: '+31612345602',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 40,
        currency: 'EUR',
        serviceCategories: ['outdoor-work'],
        businessInfo: {
          companyName: 'Vermeer Maintenance Services',
          description: 'Reliable maintenance and cleaning services for homes and businesses. Quick response time and quality work.',
          city: 'Rotterdam',
          country: 'Netherlands',
          postalCode: '3011',
          timezone: 'Europe/Amsterdam'
        }
      },
      {
        name: 'Charlotte Weber',
        email: 'charlotte.weber@fixtract.test',
        phone: '+32471234506',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 75,
        currency: 'EUR',
        serviceCategories: ['exterior', 'interior'],
        businessInfo: {
          companyName: 'Weber Construction Group',
          description: 'Full-service construction company. Kitchen and bathroom renovations, extensions, and complete home makeovers.',
          city: 'Bruges',
          country: 'Belgium',
          postalCode: '8000',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Miguel Santos',
        email: 'miguel.santos@fixtract.test',
        phone: '+32471234507',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 48,
        currency: 'EUR',
        serviceCategories: ['interior'],
        businessInfo: {
          companyName: 'Santos HVAC & Plumbing',
          description: 'Expert HVAC installation and maintenance. Emergency plumbing services available 24/7.',
          city: 'Charleroi',
          country: 'Belgium',
          postalCode: '6000',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Nina Kowalski',
        email: 'nina.kowalski@fixtract.test',
        phone: '+31612345603',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 60,
        currency: 'EUR',
        serviceCategories: ['outdoor-work'],
        businessInfo: {
          companyName: 'Kowalski Garden Design',
          description: 'Creating stunning outdoor spaces with sustainable landscaping practices. From concept to completion.',
          city: 'Utrecht',
          country: 'Netherlands',
          postalCode: '3511',
          timezone: 'Europe/Amsterdam'
        }
      },
      {
        name: 'Ahmed Hassan',
        email: 'ahmed.hassan@fixtract.test',
        phone: '+32471234508',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 52,
        currency: 'EUR',
        serviceCategories: ['exterior', 'interior'],
        businessInfo: {
          companyName: 'Hassan Renovations',
          description: 'Quality home renovations at competitive prices. Specializing in kitchen and bathroom remodeling.',
          city: 'Liège',
          country: 'Belgium',
          postalCode: '4000',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Olivia Anderson',
        email: 'olivia.anderson@fixtract.test',
        phone: '+31612345604',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 85,
        currency: 'EUR',
        serviceCategories: ['interior'],
        businessInfo: {
          companyName: 'Anderson Design Studio',
          description: 'Luxury interior design and custom finishes. Creating timeless and elegant spaces.',
          city: 'The Hague',
          country: 'Netherlands',
          postalCode: '2511',
          timezone: 'Europe/Amsterdam'
        }
      },
      {
        name: 'Viktor Petrov',
        email: 'viktor.petrov@fixtract.test',
        phone: '+32471234509',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 43,
        currency: 'EUR',
        serviceCategories: ['outdoor-work'],
        businessInfo: {
          companyName: 'Petrov Property Maintenance',
          description: 'Comprehensive property maintenance services. Lawn care, gardening, and general repairs.',
          city: 'Namur',
          country: 'Belgium',
          postalCode: '5000',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Camille Laurent',
        email: 'camille.laurent@fixtract.test',
        phone: '+32471234510',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 90,
        currency: 'EUR',
        serviceCategories: ['interior', 'exterior'],
        businessInfo: {
          companyName: 'Laurent Architecture & Design',
          description: 'Award-winning architect with a focus on sustainable and innovative design. Complete project management.',
          city: 'Brussels',
          country: 'Belgium',
          postalCode: '1000',
          timezone: 'Europe/Brussels'
        }
      },
      {
        name: 'Jan de Vries',
        email: 'jan.devries@fixtract.test',
        phone: '+31612345605',
        password: hashedPassword,
        role: 'professional',
        professionalStatus: 'approved',
        isEmailVerified: true,
        isPhoneVerified: true,
        hourlyRate: 58,
        currency: 'EUR',
        serviceCategories: ['exterior', 'outdoor-work'],
        businessInfo: {
          companyName: 'De Vries Outdoor Electric',
          description: 'Outdoor electrical installations and lighting. Garden lighting design and installation specialists.',
          city: 'Eindhoven',
          country: 'Netherlands',
          postalCode: '5611',
          timezone: 'Europe/Amsterdam'
        }
      }
    ];

    // Insert all professionals
    const createdProfessionals = await User.insertMany(professionalsData);

    console.log('');
    console.log('🎉 Successfully created professionals!');
    console.log('');
    console.log(`📊 Summary:`);
    console.log(`   Total professionals created: ${createdProfessionals.length}`);
    console.log('');
    console.log('👥 Categories breakdown:');
    console.log('   - Exterior: 8 professionals');
    console.log('   - Interior: 11 professionals');
    console.log('   - Outdoor work: 5 professionals');
    console.log('');
    console.log('🔑 All professionals use the same password: professional123');
    console.log('');
    console.log('📧 Sample login credentials:');
    console.log('   Email: marcus.janssen@fixtract.test');
    console.log('   Password: professional123');
    console.log('');
    console.log('✅ You can now view professionals on category pages like:');
    console.log('   /categories/exterior');
    console.log('   /categories/interior');
    console.log('   /categories/outdoor-work');
    console.log('');

    process.exit(0);

  } catch (error) {
    console.error('❌ Error creating professionals:', error);
    process.exit(1);
  }
};

// Run if called directly
if (require.main === module) {
  seedProfessionals();
}

export default seedProfessionals;
