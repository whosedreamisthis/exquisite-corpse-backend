// server.js
require('dotenv').config();

const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const { connectToMongo, getDb } = require('./db'); // Import DB functions
const {
	handleWebSocketMessage,
	handleWebSocketClose,
} = require('./game-handlers'); // Import handlers

const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
	res.status(200).send('Exquisite Corpse Backend is running!');
});

app.post('/api/createGame', async (req, res) => {
	try {
		const db = getDb(); // This getDb() should now always return initialized db
		const COLLECTION_NAME = 'gameRooms';
		const newGameRoom = {
			gameCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
			players: [],
			playerCount: 0,
			currentTurn: 0,
			canvasSegments: [],
			currentSegmentIndex: 0,
			createdAt: new Date(),
		};
		const result = await db
			.collection(COLLECTION_NAME)
			.insertOne(newGameRoom);
		res.status(201).json({
			message: 'Game room created successfully',
			gameId: result.insertedId,
			gameCode: newGameRoom.gameCode,
		});
	} catch (error) {
		console.error('Error creating game room:', error);
		res.status(500).json({ message: 'Failed to create game room' });
	}
});

// --- Main Server Startup Function ---
async function startServer() {
	try {
		const dbInstance = await connectToMongo(); // Await the DB connection
		console.log('MongoDB connected, starting server...');

		const server = http.createServer(app);
		const wss = new WebSocket.Server({ server });

		wss.on('connection', (ws) => {
			ws.id = Math.random().toString(36).substring(2, 15);
			ws.gameRoomId = null;
			ws.playerId = ws.id;

			console.log('Client connected via WebSocket. ID:', ws.id);

			// Pass the dbInstance directly to the handlers
			ws.on('message', (message) =>
				handleWebSocketMessage(ws, wss, dbInstance, message)
			);
			ws.on('close', () => handleWebSocketClose(ws, wss, dbInstance)); // Pass dbInstance
			ws.on('error', (error) =>
				handleWebSocketClose(ws, wss, dbInstance, error)
			); // Pass dbInstance
		});

		server.listen(PORT, () => {
			console.log(`Server listening on port ${PORT}`);
		});
	} catch (error) {
		console.error('Failed to connect to MongoDB or start server:', error);
		process.exit(1); // Exit if critical startup fails
	}
}

startServer(); // Call the async function to start everything
