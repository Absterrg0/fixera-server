import mongoose from 'mongoose';
import { config } from 'dotenv';
import ServiceConfiguration from '../models/serviceConfiguration';

config();

async function migrate() {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fixera';
    await mongoose.connect(mongoURI);
    console.log('Connected to MongoDB');

    // 1) country -> activeCountries
    const withCountry = await ServiceConfiguration.updateMany(
      { $and: [ { activeCountries: { $exists: false } }, { country: { $exists: true } } ] },
      [
        {
          $set: {
            activeCountries: {
              $cond: [
                { $gt: [ { $strLenCP: { $ifNull: ['$country', ''] } }, 0 ] },
                [ '$country' ],
                ['BE']
              ]
            }
          }
        },
        { $unset: 'country' }
      ] as any
    );
    console.log(`Updated country -> activeCountries for ${withCountry.modifiedCount} docs`);

    // 2) ensure requiredCertifications exists
    const withCerts = await ServiceConfiguration.updateMany(
      { requiredCertifications: { $exists: false } },
      { $set: { requiredCertifications: [] } }
    );
    console.log(`Initialized requiredCertifications for ${withCerts.modifiedCount} docs`);

    await mongoose.disconnect();
    console.log('Migration completed');
  } catch (err) {
    console.error('Migration failed:', (err as any).message);
    process.exit(1);
  }
}

if (require.main === module) {
  migrate();
}

export default migrate;

