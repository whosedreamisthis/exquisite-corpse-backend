// db.js
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'exquisiteCorpseDB'; // Your chosen database name in Atlas

let db; // This will hold our connected MongoDB database instance

async function connectToMongo() {
	try {
		const client = new MongoClient(MONGODB_URI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		});
		await client.connect();
		db = client.db(DB_NAME);
		console.log('Connected to MongoDB Atlas!');
		return db; // Return the db instance
	} catch (error) {
		console.error('MongoDB connection error:', error);
		process.exit(1); // Exit if DB connection fails
	}
}

// Function to get the DB instance (will be called by other modules)
function getDb() {
	if (!db) {
		throw new Error('Database not initialized! Call connectToMongo first.');
	}
	return db;
}

module.exports = {
	connectToMongo,
	getDb,
};
