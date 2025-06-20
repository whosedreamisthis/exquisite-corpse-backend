// game-handlers.js

const { ObjectId } = require('mongodb');
const WebSocket = require('ws'); // Ensure WebSocket is imported here
const { combineCanvases, overlayCanvases } = require('./canvas-utils'); // Import both combining functions

// --- Constants ---
const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4; // Define the total number of segments for the game
const CANVAS_WIDTH = 800; // Assuming fixed canvas dimensions
const CANVAS_HEIGHT = 600;

// --- WebSocket Message Handler Functions ---

/**
 * Handles incoming WebSocket messages, routing them to appropriate functions.
 * @param {WebSocket} ws The WebSocket instance for the current client.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {Db} db The MongoDB database instance.
 * @param {string} message The raw message string received from the client.
 */
async function handleWebSocketMessage(ws, wss, db, message) {
	try {
		// Ensure the message is parsed correctly (it comes as a Buffer from ws)
		const parsedMessage = JSON.parse(message.toString());
		console.log('Received from client:', parsedMessage.type);

		const {
			type,
			gameRoomId, // Will be null initially for 'joinGame', then actual ID
			gameCode,
			canvasData,
			segmentIndex,
			nickname,
		} = parsedMessage;

		let gameRoom;
		// Attempt to find game room by ID if provided (e.g., after initial join)
		if (gameRoomId) {
			try {
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(gameRoomId) });
			} catch (e) {
				console.error(
					'Backend: Invalid gameRoomId format:',
					gameRoomId,
					e
				);
				ws.send(
					JSON.stringify({
						type: 'error',
						message: 'Invalid game room ID format.',
					})
				);
				return;
			}
		}

		switch (type) {
			case 'joinGame':
				// Find or create game room using gameCode
				if (!gameCode) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game code is required to join/create.',
						})
					);
					return;
				}
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ gameCode });

				if (!gameRoom) {
					// Create new game room if it doesn't exist
					gameRoom = {
						gameCode,
						players: [], // Store player objects {id, nickname}
						playerCount: 0,
						currentSegmentIndex: 0,
						canvasSegments: [], // Stores { playerId, segmentIndex, dataUrl, timestamp }
						submittedPlayers: [], // Tracks which players submitted for currentSegmentIndex
						createdAt: new Date(),
						status: 'waiting', // New status for game room
					};
					const result = await db
						.collection(COLLECTION_NAME)
						.insertOne(gameRoom);
					gameRoom._id = result.insertedId;
					console.log(
						`Backend: Created new game room ${gameCode} with ID ${gameRoom._id}`
					);
				}

				// Add player to the room if they're not already in it
				const existingPlayer = gameRoom.players.find(
					(p) => p.id === ws.playerId
				);
				if (!existingPlayer) {
					// Limit players to 2 for this game type
					if (gameRoom.players.length >= 2) {
						ws.send(
							JSON.stringify({
								type: 'error',
								message: 'Game room is full.',
							})
						);
						return;
					}
					gameRoom.players.push({
						id: ws.playerId,
						nickname:
							nickname || `Player_${ws.playerId.substring(0, 4)}`,
					});
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
					ws.gameRoomId = gameRoom._id.toString(); // Assign gameRoomId to WebSocket for easy lookup
					console.log(
						`Backend: Player ${nickname || 'Guest'} (${
							ws.playerId
						}) joined game ${gameCode}`
					);
				} else {
					// Player reconnected, just update their gameRoomId on the ws object
					ws.gameRoomId = gameRoom._id.toString();
					console.log(
						`Backend: Player ${nickname || 'Guest'} (${
							ws.playerId
						}) reconnected to game ${gameCode}`
					);
				}

				// Prepare combined canvas data if game has started and segments exist
				let initialCanvasData = null;
				if (
					gameRoom.currentSegmentIndex > 0 &&
					gameRoom.canvasSegments.length > 0
				) {
					try {
						const previousSegmentsData = gameRoom.canvasSegments
							.filter(
								(seg) =>
									seg.segmentIndex <
									gameRoom.currentSegmentIndex
							)
							.map((seg) => seg.dataUrl);

						if (previousSegmentsData.length > 0) {
							initialCanvasData = await combineCanvases(
								previousSegmentsData
							);
						}
					} catch (combineError) {
						console.error(
							'Backend: Error combining previous canvases for new player:',
							combineError
						);
					}
				}

				// Notify all players in the room about updated player count and game state
				wss.clients.forEach((client) => {
					if (
						client.readyState === WebSocket.OPEN &&
						client.gameRoomId === ws.gameRoomId
					) {
						client.send(
							JSON.stringify({
								type: 'playerJoined',
								gameCode: gameRoom.gameCode,
								gameRoomId: gameRoom._id.toString(),
								playerCount: gameRoom.playerCount,
								currentSegmentIndex:
									gameRoom.currentSegmentIndex,
								canvasData: initialCanvasData, // Send combined canvas to new/reconnecting players
								message: `Player joined! Current players: ${gameRoom.playerCount}.`,
							})
						);
					}
				});

				// If this is the second player joining (or more if you expand),
				// and the game hasn't started (currentSegmentIndex is 0 and no submissions yet),
				// automatically advance to the first segment.
				// NEW CODE - REPLACE THE ABOVE BLOCK WITH THIS
				if (
					gameRoom.playerCount >= 2 &&
					gameRoom.currentSegmentIndex === 0 &&
					gameRoom.status === 'waiting'
				) {
					console.log(
						'Backend: Enough players. Game status set to in-progress. All players should draw the Head.'
					);
					await db.collection(COLLECTION_NAME).updateOne(
						{ _id: gameRoom._id },
						{ $set: { status: 'in-progress' } } // Update game status
					);

					// Notify all players that the game has officially started and they should draw the HEAD (segment 0)
					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoom._id.toString()
						) {
							client.send(
								JSON.stringify({
									type: 'playerJoined', // Re-use this type to update state on frontend
									gameCode: gameRoom.gameCode,
									gameRoomId: gameRoom._id.toString(),
									playerCount: gameRoom.playerCount,
									currentSegmentIndex: 0, // Explicitly tell them to draw segment 0 (Head)
									canvasData: null, // No previous canvas for the first segment
									message: 'Game started! Draw the Head.',
								})
							);
						}
					});
				}
				break;

			case 'submitSegment':
				if (!gameRoomId || segmentIndex === undefined || !canvasData) {
					console.warn('Backend: Missing data for submitSegment.');
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Incomplete submission data.',
						})
					);
					return;
				}

				// Fetch the latest gameRoom state to ensure consistency
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(gameRoomId) });
				if (!gameRoom) {
					console.error(
						`Backend: Game room ${gameRoomId} not found for submission.`
					);
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game not found.',
						})
					);
					return;
				}

				// Check if this player has already submitted for this segment
				if (gameRoom.submittedPlayers.includes(ws.playerId)) {
					console.log(
						`Backend: Player ${ws.playerId} already submitted for segment ${segmentIndex}.`
					);
					ws.send(
						JSON.stringify({
							type: 'submissionStatus',
							message:
								'You have already submitted for this segment. Waiting for others...',
						})
					);
					return;
				}

				// Ensure the submitted segment matches the current expected segment
				if (segmentIndex !== gameRoom.currentSegmentIndex) {
					console.warn(
						`Backend: Received submission for segment ${segmentIndex}, but current is ${gameRoom.currentSegmentIndex}.`
					);
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Not the current segment to submit for.',
						})
					);
					return;
				}

				// Store the submitted canvas segment and mark player as submitted
				const segmentEntry = {
					playerId: ws.playerId,
					segmentIndex: segmentIndex,
					dataUrl: canvasData,
					timestamp: new Date(),
				};

				await db.collection(COLLECTION_NAME).updateOne(
					{ _id: new ObjectId(gameRoomId) },
					{
						$push: {
							canvasSegments: segmentEntry,
							submittedPlayers: ws.playerId,
						},
						$set: { lastActivity: new Date() },
					}
				);
				console.log(
					`Backend: Stored segment ${segmentIndex} from player ${ws.playerId} for game ${gameRoomId}.`
				);

				// Re-fetch the updated game room state to get all submissions, including the one just added
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(gameRoomId) });

				// Notify the submitting player
				ws.send(
					JSON.stringify({
						type: 'submissionReceived',
						message: `Your drawing submitted for segment. Waiting for other players...`,
						currentSegmentIndex: gameRoom.currentSegmentIndex,
					})
				);

				// Check if all players have submitted for the current segment
				// Ensure playerCount is not 0 to prevent division by zero or false positive for empty rooms
				if (
					gameRoom.submittedPlayers.length ===
						gameRoom.players.length &&
					gameRoom.players.length > 0
				) {
					console.log(
						`Backend: All players (${gameRoom.players.length}) submitted for segment ${segmentIndex}. Advancing segment.`
					);
					await advanceSegment(db, wss, gameRoom._id);
				} else {
					console.log(
						`Backend: Waiting for ${
							gameRoom.players.length -
							gameRoom.submittedPlayers.length
						} more submissions for segment ${segmentIndex}.`
					);
				}
				break;

			default:
				console.warn('Backend: Unknown message type:', type);
				break;
		}
	} catch (error) {
		console.error('Backend: Error handling WebSocket message:', error);
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(
				JSON.stringify({
					type: 'error',
					message: 'Server error processing message.',
				})
			);
		}
	}
}

/**
 * Handles WebSocket client disconnections.
 * @param {WebSocket} ws The WebSocket instance for the current client.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {Db} db The MongoDB database instance.
 */
async function handleWebSocketClose(ws, wss, db) {
	console.log('Client disconnected. ID:', ws.id);
	if (!ws.gameRoomId) {
		console.log('Disconnected client was not in a game room.');
		return;
	}

	try {
		const gameId = new ObjectId(ws.gameRoomId);
		let gameRoom = await db
			.collection(COLLECTION_NAME)
			.findOne({ _id: gameId });

		if (gameRoom) {
			// Filter players based on their 'id' property within the player object
			const updatedPlayers = gameRoom.players.filter(
				(player) => player.id !== ws.playerId
			);
			let newPlayerCount = updatedPlayers.length;

			if (newPlayerCount === 0) {
				// If no players left, delete the game room (or mark as inactive)
				await db.collection(COLLECTION_NAME).deleteOne({ _id: gameId });
				console.log(
					`Game room ${ws.gameRoomId} deleted as all players disconnected.`
				);
			} else {
				// Update player count and notify remaining players
				await db.collection(COLLECTION_NAME).updateOne(
					{ _id: gameId },
					{
						$set: {
							players: updatedPlayers,
							playerCount: newPlayerCount,
							// Optionally reset game state if a player leaves during a critical phase,
							// e.g., if one player leaves while waiting for submissions.
						},
					}
				);
				console.log(
					`Player disconnected from game room ${ws.gameRoomId}. Remaining players: ${newPlayerCount}`
				);

				// Notify other clients in the room about the disconnection
				wss.clients.forEach((client) => {
					// Check if client is still open and in the same room, and not the disconnected client itself
					if (
						client.readyState === WebSocket.OPEN &&
						client.gameRoomId === ws.gameRoomId &&
						client !== ws
					) {
						client.send(
							JSON.stringify({
								type: 'playerDisconnected',
								message:
									'Other player disconnected. Waiting for a new player to join...',
								playerCount: newPlayerCount,
								// You might want to adjust isMyTurnToDraw on frontend based on new player count
							})
						);
					}
				});
			}
		}
	} catch (error) {
		console.error('Backend: Error handling WebSocket close:', error);
	}
}

/**
 * Advances the game to the next segment or ends the game.
 * This function should be called when all players have submitted their current segment.
 * @param {Db} db The MongoDB database instance.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {ObjectId} gameRoomObjectId The MongoDB ObjectId of the game room.
 */
async function advanceSegment(db, wss, gameRoomObjectId) {
	let gameRoom = await db
		.collection(COLLECTION_NAME)
		.findOne({ _id: gameRoomObjectId });

	if (!gameRoom) {
		console.error(
			`Backend: Cannot advance segment, game room ${gameRoomObjectId} not found.`
		);
		return;
	}

	let combinedCanvasData = null;
	try {
		// Collect all segment data URLs submitted for the current segment, and all previous ones
		// This creates a vertically stacked image of all completed parts
		const allSegmentsUpToCurrent = gameRoom.canvasSegments
			.filter((seg) => seg.segmentIndex <= gameRoom.currentSegmentIndex)
			.map((seg) => seg.dataUrl);

		if (allSegmentsUpToCurrent.length > 0) {
			combinedCanvasData = await combineCanvases(allSegmentsUpToCurrent);
			console.log(
				`Backend: Combined canvas for segments up to ${gameRoom.currentSegmentIndex}.`
			);
		}
	} catch (error) {
		console.error(
			`Backend: Error combining canvases for segment ${gameRoom.currentSegmentIndex}:`,
			error
		);
		// If combination fails, you might want to send a blank canvas or an error message
		combinedCanvasData = null; // Ensure it's not a broken image URL
	}

	// Increment segment index for the next round
	gameRoom.currentSegmentIndex++;
	// IMPORTANT: Clear submitted players array for the new segment
	gameRoom.submittedPlayers = [];

	// Define segments for messaging (match frontend to describe what to draw next)
	const segments = ['Head', 'Torso', 'Legs', 'Feet']; // Ensure this matches frontend's understanding

	// Check if game is over
	if (gameRoom.currentSegmentIndex >= TOTAL_SEGMENTS) {
		// Game over logic
		console.log(`Backend: Game ${gameRoom.gameCode} is over.`);

		await db.collection(COLLECTION_NAME).updateOne(
			{ _id: gameRoomObjectId },
			{
				$set: {
					currentSegmentIndex: gameRoom.currentSegmentIndex,
					submittedPlayers: gameRoom.submittedPlayers,
					fullCanvas: combinedCanvasData, // Store the final combined image
					status: 'completed', // Mark game as completed
					lastActivity: new Date(),
				},
			}
		);
		gameRoom.fullCanvas = combinedCanvasData; // Update local object for sending

		// Notify all players about game over
		wss.clients.forEach((client) => {
			if (
				client.readyState === WebSocket.OPEN &&
				client.gameRoomId === gameRoom._id.toString()
			) {
				client.send(
					JSON.stringify({
						type: 'gameOver',
						gameCode: gameRoom.gameCode,
						currentSegmentIndex: gameRoom.currentSegmentIndex,
						canvasData: gameRoom.fullCanvas, // Send the final combined canvas
						message: 'Game Over! The exquisite corpse is complete.',
					})
				);
				console.log(`Sent gameOver message to client ${client.id}.`);
			}
		});
	} else {
		// Advance to next segment logic
		console.log(
			`Backend: Advancing game ${gameRoom.gameCode} to segment ${gameRoom.currentSegmentIndex}.`
		);

		await db.collection(COLLECTION_NAME).updateOne(
			{ _id: gameRoomObjectId },
			{
				$set: {
					currentSegmentIndex: gameRoom.currentSegmentIndex,
					submittedPlayers: gameRoom.submittedPlayers,
					lastActivity: new Date(),
					status: 'in-progress', // Ensure status remains in-progress
				},
			}
		);

		// Notify all players in the room that the segment has advanced
		// Also send the combined image of previous segments as the base for the new drawing
		wss.clients.forEach((client) => {
			if (
				client.readyState === WebSocket.OPEN &&
				client.gameRoomId === gameRoom._id.toString()
			) {
				client.send(
					JSON.stringify({
						type: 'segmentAdvanced',
						gameCode: gameRoom.gameCode,
						currentSegmentIndex: gameRoom.currentSegmentIndex,
						canvasData: combinedCanvasData, // Send the combined previous segment as background
						message: `New segment started! Draw the ${
							segments[gameRoom.currentSegmentIndex]
						}.`,
					})
				);
				console.log(
					`Sent segmentAdvanced message to client ${
						client.id
					}. Canvas data sent: ${!!combinedCanvasData}`
				);
			}
		});
	}
}

// Export the functions that are called from server.js
module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
	// advanceSegment is called internally, no need to export it if not called from server.js
};
