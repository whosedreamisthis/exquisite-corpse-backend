// Load environment variables from .env file
require('dotenv').config();

const WebSocket = require('ws');
const { MongoClient, ObjectId } = require('mongodb'); // Import ObjectId for querying by ID
const http = require('http'); // Used to create an HTTP server that WS will attach to
const express = require('express'); // Optional: for basic HTTP routes

// --- Configuration ---
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 8080; // Use Render's/Glitch's PORT or default to 8080
const DB_NAME = 'exquisiteCorpseDB'; // Your chosen database name in Atlas
const COLLECTION_NAME = 'gameRooms'; // Collection to store game data (e.g., drawing history, current canvas)

// --- MongoDB Connection ---
let db; // Variable to hold the connected MongoDB database instance

async function connectToMongo() {
	try {
		const client = new MongoClient(MONGODB_URI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		});
		await client.connect();
		db = client.db(DB_NAME);
		console.log('Connected to MongoDB Atlas!');
		// Start watching for changes once connected to the DB
		startChangeStream();
	} catch (error) {
		console.error('MongoDB connection error:', error);
		// It's critical to have a DB connection, so exit if it fails
		process.exit(1);
	}
}

// --- Express App (for HTTP routes, e.g., health checks or initial game room creation) ---
const app = express();
app.use(express.json()); // Enable JSON body parsing for API routes

// Simple health check or root endpoint
app.get('/', (req, res) => {
	res.status(200).send('Exquisite Corpse Backend is running!');
});

// Example: HTTP endpoint to create a new game room
app.post('/api/createGame', async (req, res) => {
	try {
		const newGameRoom = {
			gameCode: Math.random().toString(36).substring(2, 8).toUpperCase(), // Simple random code
			players: [],
			currentTurn: 0,
			canvasSegments: [], // Array to store drawing segments/Base64 images
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
// Create an HTTP server instance (Express app is an HTTP server)
const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); // Attach WebSocket server to the HTTP server

wss.on('connection', (ws) => {
	console.log('Client connected via WebSocket');

	// Handle messages received from clients
	ws.on('message', async (message) => {
		try {
			const data = JSON.parse(message.toString());
			console.log('Received from client:', data);

			if (data.type === 'joinGame') {
				// Client wants to join a game room
				const gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ gameCode: data.gameCode });
				if (gameRoom) {
					console.log(`Client joined game room: ${data.gameCode}`);
					// Store game room ID on the WebSocket for later filtering
					ws.gameRoomId = gameRoom._id.toString();
					// Send initial game state to the new client
					ws.send(
						JSON.stringify({
							type: 'initialGameState',
							gameRoom: gameRoom,
						})
					);
				} else {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room not found.',
						})
					);
				}
			} else if (
				data.type === 'drawUpdate' &&
				data.gameRoomId &&
				data.canvasData
			) {
				// Client sent drawing data (e.g., a Base64 image of the current canvas)
				const gameId = new ObjectId(data.gameRoomId); // Convert string ID to MongoDB ObjectId
				await db
					.collection(COLLECTION_NAME)
					.updateOne(
						{ _id: gameId },
						{
							$set: {
								[`canvasSegments.${data.segmentIndex}`]:
									data.canvasData,
								lastUpdated: new Date(),
							},
						}
					);
				// The update to MongoDB will trigger the Change Stream,
				// which will then broadcast to all relevant clients.
			}
			// Add more message types for other game actions (e.g., 'nextTurn', 'finishSegment')
		} catch (error) {
			console.error('Error processing client message:', error);
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(
					JSON.stringify({
						type: 'error',
						message: 'Invalid message format or server error.',
					})
				);
			}
		}
	});

	ws.on('close', () => {
		console.log('Client disconnected from WebSocket');
	});

	ws.on('error', (error) => {
		console.error('WebSocket error:', error);
	});
});

// --- MongoDB Change Stream ---
async function startChangeStream() {
	const collection = db.collection(COLLECTION_NAME);

	// Watch for 'update' operations specifically for the 'canvasSegments' field
	// You can refine this pipeline to listen for specific fields or operations
	const pipeline = [
		{
			$match: {
				operationType: 'update',
				'updateDescription.updatedFields': { $exists: true },
				// Optionally: 'updateDescription.updatedFields.canvasSegments': { $exists: true }
			},
		},
		{
			$project: {
				fullDocument: 1,
				documentKey: 1, // Contains _id of the changed document
				updateDescription: 1, // Contains updatedFields and removedFields
			},
		},
	];

	const changeStream = collection.watch(pipeline);

	changeStream.on('change', (change) => {
		console.log(
			'Change detected in MongoDB:',
			change.operationType,
			'for document:',
			change.documentKey._id
		);

		// Iterate over all connected WebSocket clients
		wss.clients.forEach((client) => {
			// Check if the client is still open and if it belongs to the affected game room
			if (
				client.readyState === WebSocket.OPEN &&
				client.gameRoomId === change.documentKey._id.toString()
			) {
				// Send the updated canvas data to clients in that specific game room
				if (
					change.fullDocument &&
					change.updateDescription &&
					change.updateDescription.updatedFields
				) {
					// Find which canvas segment was updated
					for (const key in change.updateDescription.updatedFields) {
						if (key.startsWith('canvasSegments.')) {
							const segmentIndex = parseInt(key.split('.')[1]);
							const updatedCanvasData =
								change.fullDocument.canvasSegments[
									segmentIndex
								];

							client.send(
								JSON.stringify({
									type: 'canvasUpdate',
									gameRoomId:
										change.documentKey._id.toString(),
									segmentIndex: segmentIndex,
									canvasData: updatedCanvasData,
								})
							);
							break; // Assuming only one segment is updated per message for simplicity
						}
					}
				}
			}
		});
	});

	changeStream.on('error', (error) => {
		console.error('Change stream error:', error);
	});

	// Handle change stream resume (important for production)
	// You would typically store resume tokens in your DB or a robust state
	// For this hobby project, simple reconnection might be sufficient,
	// but a production app would use change.resumeToken to restart the stream correctly.
}

// --- Start the Server ---
server.listen(PORT, () => {
	console.log(`Backend server listening on port ${PORT}`);
	// Connect to MongoDB when the server starts listening
	connectToMongo();
});
