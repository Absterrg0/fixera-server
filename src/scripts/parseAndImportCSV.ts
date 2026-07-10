import mongoose from "mongoose";
import ServiceConfiguration from "../models/serviceConfiguration";
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";

config();

// Parse dynamic field from text
function parseDynamicField(fieldText: string): {
  isDynamic: boolean;
  field?: any;
  name: string;
} {
  const text = fieldText.trim();

  // Building Type - always a dropdown
  if (text.toLowerCase() === "building type") {
    return {
      isDynamic: true,
      name: "Building Type",
      field: {
        fieldName: "buildingType",
        fieldType: "dropdown",
        label: "Building Type",
        isRequired: true,
        options: [
          "Terraced House",
          "Semi-Detached House",
          "Detached House",
          "Room",
          "Studio",
          "Flat",
          "Garage",
          "Commercial Unit",
          "Industrial Unit",
          "Office",
          "Storage Unit",
          "Other",
        ],
      },
    };
  }

  // Range fields with m2, m3, meter, Period
  if (text.toLowerCase().startsWith("range ")) {
    const match = text.match(
      /range\s+(m2|m3|m²|meter|period|fence\s+length)\s*(.+)?/i,
    );
    if (match) {
      let unit = match[1].toLowerCase();
      if (unit === "m²") unit = "m2";
      if (unit.includes("fence") || unit.includes("meter")) unit = "meter";
      if (unit === "period") unit = "days";

      const description = match[2] || "";
      const fieldName = `range_${unit}_${description}`
        .replace(/\s+/g, "_")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "");

      return {
        isDynamic: true,
        name: text,
        field: {
          fieldName,
          fieldType: "range",
          unit: unit === "days" ? "days" : unit,
          label: text,
          isRequired: true,
          min: 0,
        },
      };
    }
  }

  // Specific capacity/power/size fields
  const patterns = [
    {
      regex: /^kWh?\s+Battery\s+Capacity$/i,
      unit: "kWh",
      fieldName: "batteryCapacity",
    },
    { regex: /^Wp\s+system\s+power$/i, unit: "Wp", fieldName: "systemPowerWp" },
    { regex: /^kW\s+system\s+power$/i, unit: "kW", fieldName: "systemPowerKw" },
    {
      regex: /^kW\s+Chargepoint\s+Power$/i,
      unit: "kW",
      fieldName: "chargepointPower",
    },
    { regex: /^m3\/h\s+Airflow$/i, unit: "m3/h", fieldName: "airflow" },
    { regex: /^m3\s+Skip\s+Size$/i, unit: "m3", fieldName: "skipSize" },
    { regex: /^m3\s+Vehicle\s+Size$/i, unit: "m3", fieldName: "vehicleSize" },
    { regex: /^m3\s+Tank\s+Capacity$/i, unit: "m3", fieldName: "tankCapacity" },
    {
      regex: /^m3\s+size\s+garden\s+building$/i,
      unit: "m3",
      fieldName: "gardenBuildingSize",
    },
    { regex: /^m3\s+material$/i, unit: "m3", fieldName: "materialVolume" },
    { regex: /^m2\s+Pool\s+size$/i, unit: "m2", fieldName: "poolSize" },
    { regex: /^m3\s+Pool\s+Volume$/i, unit: "m3", fieldName: "poolVolume" },
    { regex: /^Car\s+Capacity$/i, unit: "cars", fieldName: "carCapacity" },
    { regex: /^Design\s+revisions?$/i, unit: "", fieldName: "designRevisions" },
    {
      regex: /^lifting\s+Weight\s+Limit$/i,
      unit: "kg",
      fieldName: "liftingWeightLimit",
    },
    {
      regex: /^upholstery\s+Quantity\s+range$/i,
      unit: "",
      fieldName: "upholsteryQuantity",
    },
    {
      regex: /^item\s+Quantity\s+range$/i,
      unit: "",
      fieldName: "itemQuantity",
    },
  ];

  for (const { regex, unit, fieldName } of patterns) {
    if (regex.test(text)) {
      // Special case for quantities and revisions - use range
      if (fieldName.includes("Quantity") || fieldName === "designRevisions") {
        return {
          isDynamic: true,
          name: text,
          field: {
            fieldName,
            fieldType: "range",
            unit: unit || "units",
            label: text,
            isRequired: fieldName === "designRevisions" ? false : true,
            min: fieldName === "designRevisions" ? 0 : 1,
            max: fieldName === "designRevisions" ? 10 : undefined,
            isSingleNumber: fieldName === "designRevisions" ? true : false,
          },
        };
      }

      return {
        isDynamic: true,
        name: text,
        field: {
          fieldName,
          fieldType: "number",
          unit,
          label: text,
          isRequired: true,
          min: 0,
        },
      };
    }
  }

  // Not a dynamic field
  return { isDynamic: false, name: text };
}

// Parse CSV line
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Parse CSV file
function parseCSVFile(filePath: string): any[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  const headers = parseCSVLine(lines[0]);
  const data: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: any = {};

    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });

    data.push(row);
  }

  return data;
}

// Convert CSV row to ServiceConfiguration
function convertToServiceConfig(row: any): any {
  const includedRaw =
    row["Included"]
      ?.split(";")
      .map((s: string) => s.trim())
      .filter(Boolean) || [];
  const extrasRaw =
    row["Possible extras"]
      ?.split(";")
      .map((s: string) => s.trim())
      .filter(Boolean) || [];
  const conditionsRaw =
    row["Conditions & Warnings"]
      ?.split(";")
      .map((s: string) => s.trim())
      .filter(Boolean) || [];
  const typesRaw =
    row["Type"]
      ?.split(";")
      .map((s: string) => s.trim())
      .filter(Boolean) || [];

  // Parse included items and extract dynamic fields
  const includedItems: any[] = [];
  const professionalInputFields: any[] = [];

  for (const item of includedRaw) {
    const parsed = parseDynamicField(item);

    if (parsed.isDynamic && parsed.field) {
      professionalInputFields.push(parsed.field);
      includedItems.push({
        name: parsed.name,
        isDynamic: true,
        dynamicField: parsed.field,
      });
    } else {
      includedItems.push({
        name: parsed.name,
        isDynamic: false,
      });
    }
  }

  // Parse extras
  const extraOptions = extrasRaw.map((opt: string) => ({
    name: opt,
    isCustomizable: true,
  }));

  // Parse conditions/warnings
  const conditionsAndWarnings = conditionsRaw.map((text: string) => {
    const isWarning =
      text.toLowerCase().includes("risk") ||
      text.toLowerCase().includes("delay") ||
      text.toLowerCase().includes("damage") ||
      text.toLowerCase().includes("nuisance") ||
      text.toLowerCase().includes("possible");

    return {
      text,
      type: isWarning ? "warning" : "condition",
    };
  });

  return {
    category: row["Category"]?.trim(),
    service: row["Service"]?.trim(),
    areaOfWork:
      row["Area of Work"]?.trim() === "Not applicable"
        ? undefined
        : row["Area of Work"]?.trim(),
    pricingModel: row["Pricing Model"]?.trim() || "Total price",
    certificationRequired: row["Certification"]?.toLowerCase() === "yes",
    projectTypes: typesRaw,
    includedItems,
    professionalInputFields,
    extraOptions,
    conditionsAndWarnings,
    isActive: true,
    activeCountries: ["BE"],
    requiredCertifications: [],
  };
}

async function importFromCSV() {
  try {
    const csvPath = path.join(
      __dirname,
      "../public/Fixtract service data ENG.csv",
    );

    console.log("📖 Reading CSV file...");
    const rows = parseCSVFile(csvPath);
    console.log(`✅ Parsed ${rows.length} rows from CSV`);

    console.log("🔄 Converting to service configurations...");
    const serviceConfigs = rows.map((row) => convertToServiceConfig(row));
    console.log(`✅ Converted ${serviceConfigs.length} service configurations`);

    // Connect to MongoDB
    const mongoURI =
      process.env.MONGODB_URI || "mongodb://localhost:27017/fixera";
    await mongoose.connect(mongoURI);
    console.log("✅ Connected to MongoDB");

    // Clear existing
    const deleteResult = await ServiceConfiguration.deleteMany({});
    console.log(
      `🗑️  Cleared ${deleteResult.deletedCount} existing service configurations`,
    );

    // Insert all
    const insertResult = await ServiceConfiguration.insertMany(serviceConfigs);
    console.log(
      `✅ Successfully imported ${insertResult.length} service configurations`,
    );

    // Show summary
    const categories = await ServiceConfiguration.distinct("category");
    console.log(`\n📊 Summary:`);
    console.log(`   Categories: ${categories.length}`);
    for (const category of categories.sort()) {
      const count = await ServiceConfiguration.countDocuments({ category });
      console.log(`   - ${category}: ${count} services`);
    }

    await mongoose.disconnect();
    console.log("\n👋 Disconnected from MongoDB");
    console.log("✨ Import completed successfully!");
  } catch (error: any) {
    console.error("❌ Error importing:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  importFromCSV();
}

export default importFromCSV;
