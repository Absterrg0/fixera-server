import mongoose from 'mongoose'
import { config } from 'dotenv'
import ServiceConfiguration from '../models/serviceConfiguration'

config()

async function migrate() {
  const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fixera'
  await mongoose.connect(mongoURI)
  console.log('Connected to MongoDB')

  let updated = 0
  let inspected = 0

  // Load all service configurations to safely transform documents using JS
  const all = await ServiceConfiguration.find({}) as any[]
  console.log(`Found ${all.length} service configurations`)

  for (const doc of all) {
    inspected++
    let changed = false

    // Backfill activeCountries from legacy country or default to ['BE']
    const hasActiveCountries = Array.isArray(doc.activeCountries) && doc.activeCountries.filter(Boolean).length > 0
    if (!hasActiveCountries) {
      const legacyCountry = (doc as any).country
      const nextCountries = legacyCountry ? [legacyCountry] : ['BE']
      doc.activeCountries = nextCountries
      changed = true
    }

    // Ensure isActive defaults to true if missing
    if (typeof doc.isActive !== 'boolean') {
      doc.isActive = true
      changed = true
    }

    if (changed) {
      await doc.save()
      updated++
    }
  }

  console.log(`Inspected: ${inspected}, Updated: ${updated}`)
  await mongoose.disconnect()
  console.log('Disconnected')
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
}

export default migrate

