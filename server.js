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

// --- Express App ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
	res.status(200).send('Exquisite Corpse Backend is running!');
});

// Example: HTTP endpoint to create a new game room (can still be useful for initial setup)
app.post('/api/createGame', async (req, res) => {
	try {
		const db = getDb(); // Get the connected DB instance
		const COLLECTION_NAME = 'gameRooms'; // Define here or pass from config
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

// --- WebSocket Server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
	ws.id = Math.random().toString(36).substring(2, 15);
	ws.gameRoomId = null;
	ws.playerId = ws.id;

	console.log('Client connected via WebSocket. ID:', ws.id);

	// Pass ws, wss (for broadcasting), and db to the message handler
	ws.on('message', (message) =>
		handleWebSocketMessage(ws, wss, getDb(), message)
	);

	// Pass ws, db, and wss to the close handler
	ws.on('close', () => handleWebSocketClose(ws, getDb(), wss));

	ws.on('error', (error) => {
		console.error('WebSocket error:', error);
	});
});

// --- Start the Server ---
server.listen(PORT, async () => {
	console.log(`Backend server listening on port ${PORT}`);
	// Connect to MongoDB when the server starts, and ensure DB instance is available
	await connectToMongo();
});
