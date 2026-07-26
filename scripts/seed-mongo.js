const fs = require("fs/promises");
const path = require("path");
const { MongoClient } = require("mongodb");
const { loadEnv } = require("../env");

loadEnv();

const CHANNELS_FILE = path.join(__dirname, "..", "data", "channels.json");
const DATABASE_NAME = process.env.MONGODB_DB || "jv_tv";
const COLLECTION_NAME = process.env.MONGODB_COLLECTION || "channels";

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("Configure MONGODB_URI no .env antes de importar.");
  }

  const file = await fs.readFile(CHANNELS_FILE, "utf8");
  const channels = JSON.parse(file);
  const client = new MongoClient(process.env.MONGODB_URI);

  await client.connect();
  const collection = client.db(DATABASE_NAME).collection(COLLECTION_NAME);

  for (const channel of channels) {
    await collection.updateOne({ id: channel.id }, { $set: channel }, { upsert: true });
  }

  await client.close();
  console.log(`Importados ${channels.length} canais para ${DATABASE_NAME}.${COLLECTION_NAME}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
