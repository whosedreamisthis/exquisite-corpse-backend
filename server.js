// server.js
require('dotenv').config();

const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const cors = require('cors');

const { connectToMongo, getDb } = require('./db');
const {
	handleWebSocketMessage,
	handleWebSocketClose,
} = require('./game-handlers');

const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json());
app.use(cors());

app.get('/', (req, res) => {
	res.status(200).send('Exquisite Corpse Backend is running!');
});

app.post('/api/createGame', async (req, res) => {
	try {
		const db = getDb();
		const COLLECTION_NAME = 'gameRooms';
		const newGameRoom = {
			gameCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
			players: [], // Stores WS IDs
			playerObjects: [], // Stores {id, name}
			playerCount: 0,
			currentSegmentIndex: 0,
			submittedPlayers: [], // Stores playerIds who submitted for the current segment
			currentSegmentSubmissions: {}, // Stores individual player submissions for the current segment
			status: 'waiting',
			createdAt: new Date(),
			// --- NEW FIELDS FOR TWO-CANVAS GAMEPLAY ---
			artworks: [
				{
					segments: [], // Segments for artwork 1
					finalArtwork: null, // Combined image for artwork 1
				},
				{
					segments: [], // Segments for artwork 2
					finalArtwork: null, // Combined image for artwork 2
				},
			],
			// Maps playerId to the index of the artwork they are currently drawing on (0 or 1)
			playerCanvasAssignments: {},
			// --- END NEW FIELDS ---
		};
		const result = await db
			.collection(COLLECTION_NAME)
			.insertOne(newGameRoom);
		console.log(
			`Successfully created game room with code: ${newGameRoom.gameCode} and ID: ${result.insertedId}`
		);
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
		const dbInstance = await connectToMongo();
		console.log('MongoDB connected, starting server...');

		const server = http.createServer(app);
		const wss = new WebSocket.Server({ server });

		wss.on('connection', (ws) => {
			ws.id = Math.random().toString(36).substring(2, 15);
			ws.gameRoomId = null;
			ws.playerId = ws.id; // Assign a unique ID to the WebSocket connection

			console.log('Client connected via WebSocket. ID:', ws.id);

			ws.on('message', (message) =>
				handleWebSocketMessage(ws, wss, dbInstance, message)
			);
			ws.on('close', () => handleWebSocketClose(ws, wss, dbInstance));
			ws.on('error', (error) => {
				console.error('WebSocket error for client', ws.id, ':', error);
			});
		});

		server.listen(PORT, () => {
			console.log(`Server is running on port ${PORT}`);
		});
	} catch (error) {
		console.error('Failed to start server:', error);
		process.exit(1);
	}
}

startServer();
