const fs = require("fs/promises");
const path = require("path");

const CHANNELS_FILE = path.join(__dirname, "data", "channels.json");
const DATABASE_NAME = process.env.MONGODB_DB || "jv_tv";
const COLLECTION_NAME = process.env.MONGODB_COLLECTION || "channels";

let mongoClientPromise = null;

async function getMongoCollection() {
  if (!process.env.MONGODB_URI) return null;

  if (!mongoClientPromise) {
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(process.env.MONGODB_URI);
    mongoClientPromise = client.connect();
  }

  const client = await mongoClientPromise;
  return client.db(DATABASE_NAME).collection(COLLECTION_NAME);
}

async function readJsonChannels() {
  try {
    const file = await fs.readFile(CHANNELS_FILE, "utf8");
    return JSON.parse(file);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonChannels(channels) {
  await fs.writeFile(CHANNELS_FILE, `${JSON.stringify(channels, null, 2)}\n`);
}

async function ensureMongoSeed(collection) {
  const count = await collection.countDocuments();
  if (count > 0) return;

  const channels = await readJsonChannels();
  if (channels.length) await collection.insertMany(channels);
}

async function readChannels() {
  const collection = await getMongoCollection();
  if (!collection) return readJsonChannels();

  await ensureMongoSeed(collection);
  return collection.find({}, { projection: { _id: 0 } }).sort({ category: 1, name: 1 }).toArray();
}

async function findChannelById(id) {
  const collection = await getMongoCollection();
  if (!collection) {
    const channels = await readJsonChannels();
    return channels.find((channel) => channel.id === id) || null;
  }

  await ensureMongoSeed(collection);
  return collection.findOne({ id }, { projection: { _id: 0 } });
}

async function addChannel(channel) {
  const collection = await getMongoCollection();
  if (!collection) {
    const channels = await readJsonChannels();
    channels.push(channel);
    await writeJsonChannels(channels);
    return channel;
  }

  await collection.updateOne({ id: channel.id }, { $set: channel }, { upsert: true });
  return channel;
}

module.exports = {
  addChannel,
  findChannelById,
  readChannels
};
