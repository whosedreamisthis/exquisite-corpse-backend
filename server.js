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

// Example: HTTP endpoint to create a new game room - This can stay, but your primary 'create' will be via joinGame WS
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
	ws.id = Math.random().toString(36).substring(2, 15);

	console.log('Client connected via WebSocket. Assigned ID:', ws.id); // Added ws.id to log

	// Handle messages received from clients
	ws.on('message', async (message) => {
		try {
			const data = JSON.parse(message.toString());
			console.log('Received from client:', data);

			if (data.type === 'joinGame') {
				// Client wants to join a game room
				const gameCode = data.gameCode.toUpperCase(); // Ensure game code is uppercase for consistency
				let gameRoom = await db // Use 'let' so we can reassign if creating a new room
					.collection(COLLECTION_NAME)
					.findOne({ gameCode: gameCode });

				if (gameRoom) {
					// Game room found, proceed to join
					console.log(
						`Client ${ws.id} joining existing game room: ${gameCode}`
					);
					// Store game room ID on the WebSocket for later filtering
					ws.gameRoomId = gameRoom._id.toString();

					// Add player to the gameRoom if not already there (assuming 'players' array)
					// *** IMPORTANT CHANGE 1 & 2 HERE ***
					if (!gameRoom.players.includes(ws.id)) {
						// CHANGED: from ws.gameRoomId to ws.id
						gameRoom.players.push(ws.id); // CHANGED: from ws.gameRoomId to ws.id
						gameRoom.playerCount = gameRoom.players.length;

						await db.collection(COLLECTION_NAME).updateOne(
							{ _id: gameRoom._id },
							{
								$set: {
									players: gameRoom.players,
									playerCount: gameRoom.playerCount,
								},
							}
						);
						console.log(
							`Player ${ws.id} added to room ${gameCode}. New playerCount: ${gameRoom.playerCount}`
						); // Added console log
					} else {
						console.log(
							`Client ${ws.id} already in room ${gameCode}. Sending current state.`
						);
					}

					// Send initial game state to the new client
					ws.send(
						JSON.stringify({
							type: 'initialState',
							gameCode: gameRoom.gameCode,
							playerCount: gameRoom.playerCount,
							currentSegmentIndex:
								gameRoom.currentSegmentIndex || 0,
							canvasData:
								gameRoom.canvasSegments[
									gameRoom.currentSegmentIndex
								] || null,
							message: `Joined game ${gameCode}.`,
						})
					);

					// If 2 players are now in the room, notify both to start
					if (gameRoom.playerCount === 2) {
						wss.clients.forEach((client) => {
							if (
								client.readyState === WebSocket.OPEN &&
								client.gameRoomId === ws.gameRoomId
							) {
								client.send(
									JSON.stringify({
										type: 'playerJoined',
										gameCode: gameRoom.gameCode,
										playerCount: gameRoom.playerCount,
										message: `Game ${gameRoom.gameCode} started!`,
									})
								);
							}
						});
					}
				} else {
					// Game room not found, create a new one
					console.log(
						'Creating new game room for gameCode:',
						gameCode
					);
					const newGameRoom = {
						gameCode: gameCode, // Use the gameCode from the client here
						players: [ws.id], // Initialize with the creator's ws.id
						playerCount: 1, // Initialize playerCount for new room
						currentTurn: 0, // Player who created is player 0
						canvasSegments: [], // Array to store drawing segments/Base64 images
						currentSegmentIndex: 0, // Start with the first segment
						createdAt: new Date(),
					};
					console.log('New game room details:', newGameRoom);
					const result = await db
						.collection(COLLECTION_NAME)
						.insertOne(newGameRoom);
					gameRoom = { _id: result.insertedId, ...newGameRoom }; // Get the full created document
					console.log('NEW GAME ROOM created in DB:', gameRoom);
					// Now, associate the new client with this newly created room
					ws.gameRoomId = gameRoom._id.toString();

					// Send initial game state to the new client (the creator)
					ws.send(
						JSON.stringify({
							type: 'initialState',
							gameCode: gameRoom.gameCode,
							playerCount: gameRoom.playerCount,
							currentSegmentIndex: gameRoom.currentSegmentIndex,
							canvasData: null,
							message: `Game ${gameCode} created! Waiting for another player...`,
						})
					);
				}
			} else if (
				data.type === 'submitSegment' &&
				data.gameRoomId &&
				data.canvasData
			) {
				// Client submitted drawing data (e.g., a Base64 image of the current canvas)
				const gameId = new ObjectId(data.gameRoomId);
				const gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: gameId });

				if (!gameRoom) {
					console.error(
						'SubmitSegment: Game room not found for ID:',
						data.gameRoomId
					);
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room not found.',
						})
					);
					return;
				}

				// Check if it's this player's turn to submit (you'll need to implement turn logic)
				// *** IMPORTANT CHANGE 3 HERE ***
				const playerIndex = gameRoom.players.indexOf(ws.id); // CHANGED: from ws.gameRoomId to ws.id
				if (
					playerIndex === -1 ||
					gameRoom.currentTurn !== playerIndex
				) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: "It's not your turn to submit.",
						})
					);
					return;
				}

				// Update the canvas segment in the database
				const updatePath = `canvasSegments.${data.segmentIndex}`;
				await db.collection(COLLECTION_NAME).updateOne(
					{ _id: gameId },
					{
						$set: {
							[updatePath]: data.canvasData,
							lastUpdated: new Date(),
						},
					}
				);

				// Determine next turn and segment
				const nextTurn =
					(gameRoom.currentTurn + 1) % gameRoom.players.length;
				let nextSegmentIndex = gameRoom.currentSegmentIndex; // Keep the same segment for now

				// Update turn in DB
				await db.collection(COLLECTION_NAME).updateOne(
					{ _id: gameId },
					{
						$set: {
							currentTurn: nextTurn,
						},
					}
				);

				// Notify both players about the submission and waiting state
				wss.clients.forEach((client) => {
					if (
						client.readyState === WebSocket.OPEN &&
						client.gameRoomId === data.gameRoomId
					) {
						if (client === ws) {
							// This player submitted
							client.send(
								JSON.stringify({
									type: 'waitingForOtherPlayerSubmit',
									message: `You submitted your segment! Waiting for other player...`,
								})
							);
						} else {
							// The other player in the room
							client.send(
								JSON.stringify({
									type: 'waitingForOtherPlayerSubmit',
									message: `Other player submitted their segment. Your turn next!`,
								})
							);
						}
					}
				});
			} else if (
				data.type === 'drawUpdate' &&
				data.gameRoomId &&
				data.canvasData
			) {
				// Client sent drawing data (e.g., a Base64 image of the current canvas)
				const gameId = new ObjectId(data.gameRoomId);
				await db.collection(COLLECTION_NAME).updateOne(
					{ _id: gameId },
					{
						$set: {
							[`canvasSegments.${data.segmentIndex}`]:
								data.canvasData,
							lastUpdated: new Date(),
						},
					}
				);
			}
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

	ws.on('close', async () => {
		console.log('Client disconnected from WebSocket. ID:', ws.id); // Added ws.id to log
		// Clean up player from the game room if they were associated
		if (ws.gameRoomId) {
			try {
				const gameId = new ObjectId(ws.gameRoomId);
				const gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: gameId });
				if (gameRoom) {
					// *** IMPORTANT CHANGE 4 HERE ***
					const updatedPlayers = gameRoom.players.filter(
						(playerId) => playerId !== ws.id // CHANGED: from ws.gameRoomId to ws.id
					);

					// If a player disconnects, you might want to reset the game or mark it as inactive
					if (updatedPlayers.length === 0) {
						// Optionally delete the game room if no players are left
						await db
							.collection(COLLECTION_NAME)
							.deleteOne({ _id: gameId });
						console.log(
							`Game room ${ws.gameRoomId} deleted as all players disconnected.`
						);
					} else {
						await db.collection(COLLECTION_NAME).updateOne(
							{ _id: gameId },
							{
								$set: {
									players: updatedPlayers,
									playerCount: updatedPlayers.length,
								},
							}
						);
						console.log(
							`Player disconnected from game room ${ws.gameRoomId}. Remaining players: ${updatedPlayers.length}`
						);
						// Notify remaining player if there's only one left
						wss.clients.forEach((client) => {
							if (
								client.readyState === WebSocket.OPEN &&
								client.gameRoomId === ws.gameRoomId
							) {
								client.send(
									JSON.stringify({
										type: 'playerDisconnected',
										message:
											'Other player disconnected. Waiting for a new player to join...',
										playerCount: updatedPlayers.length,
									})
								);
							}
						});
					}
				}
			} catch (error) {
				console.error(
					'Error handling client disconnect cleanup:',
					error
				);
			}
		}
	});

	ws.on('error', (error) => {
		console.error('WebSocket error:', error);
	});
});

// --- MongoDB Change Stream ---
async function startChangeStream() {
	const collection = db.collection(COLLECTION_NAME);

	const pipeline = [
		{
			$match: {
				operationType: 'update',
				'updateDescription.updatedFields': { $exists: true },
			},
		},
		{
			$project: {
				fullDocument: 1,
				documentKey: 1,
				updateDescription: 1,
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
							break;
						}
					}
				}
			}
		});
	});

	changeStream.on('error', (error) => {
		console.error('Change stream error:', error);
	});
}

// --- Start the Server ---
server.listen(PORT, () => {
	console.log(`Backend server listening on port ${PORT}`);
	// Connect to MongoDB when the server starts listening
	connectToMongo();
});
