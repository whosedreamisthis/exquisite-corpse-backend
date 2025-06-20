// game-handlers.js

const { ObjectId } = require('mongodb');
const WebSocket = require('ws'); // Ensure WebSocket is imported here
const {
	combineCanvases,
	overlayCanvases,
	createCanvasWithBottomPeek,
} = require('./canvas-utils'); // Import new function

// --- Constants ---
const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4; // Define the total number of segments for the game
const MAX_PLAYERS = 2; // Define the maximum number of players
const CANVAS_WIDTH = 800; // Assuming fixed canvas dimensions
const CANVAS_HEIGHT = 600;
const PEEK_HEIGHT = 100; // Define the height of the "peek" from the previous segment

// Segments for the game (Head, Torso, Legs, Feet)
const segments = ['Head', 'Torso', 'Legs', 'Feet'];

// Helper to create a blank canvas data URL (might not be needed if canvas-utils has it)
function createCanvas(width, height) {
	const { createCanvas } = require('canvas'); // Local import for this helper
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext('2d');
	ctx.clearRect(0, 0, width, height); // Ensure it's transparent
	return canvas;
}

// --- WebSocket Message Handler Functions ---

/**
 * Handles incoming WebSocket messages, routing them to appropriate functions.
 * @param {WebSocket} ws The WebSocket instance for the current client.
 * @param {WebSocket.Server} wss The WebSocket server instance.\
 * @param {Db} db The MongoDB database instance.
 * @param {string} message The incoming message string.
 */
async function handleWebSocketMessage(ws, wss, db, message) {
	const parsedMessage = JSON.parse(message);
	const { type, gameCode, playerName, gameRoomId, canvasData, playerId } =
		parsedMessage;

	switch (type) {
		case 'joinGame':
			try {
				console.log(
					`[JOIN GAME] Player ${playerName || 'Unknown'} (WS ID: ${
						ws.playerId
					}) attempting to join game code: ${gameCode}`
				);

				if (!gameCode || !playerName || !ws.playerId) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Invalid join data.',
						})
					);
					return;
				}

				let gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ gameCode: gameCode });

				if (!gameRoom) {
					console.log(
						`[JOIN GAME] Game room ${gameCode} not found for WS ID: ${ws.playerId}`
					);
					ws.send(
						JSON.stringify({
							type: 'error',
							message:
								'Game not found. Create a new one or check code.',
						})
					);
					return;
				}
				console.log(
					`[JOIN GAME] Found game room ${gameCode} for WS ID: ${ws.playerId}. Initial playerCount: ${gameRoom.playerCount}, Status: ${gameRoom.status}`
				);

				// Check if player is already in this game room (re-connecting logic)
				if (gameRoom.playerObjects.some((p) => p.id === ws.playerId)) {
					ws.gameRoomId = gameRoom._id.toHexString();
					console.log(
						`[JOIN GAME] Player ${playerName} (${ws.playerId}) re-joined game ${gameCode}`
					);

					const canDraw =
						gameRoom.players[gameRoom.currentTurn] === ws.playerId;
					const isWaitingForOthers =
						gameRoom.status === 'playing' &&
						gameRoom.submittedPlayers.includes(ws.playerId);
					let initialCanvasData = null;
					if (gameRoom.currentSegmentIndex > 0) {
						initialCanvasData = await createCanvasWithBottomPeek(
							gameRoom.canvasSegments[
								gameRoom.currentSegmentIndex - 1
							],
							CANVAS_WIDTH,
							CANVAS_HEIGHT,
							PEEK_HEIGHT
						);
					} else if (gameRoom.status === 'completed') {
						initialCanvasData = gameRoom.finalArtwork;
					}

					ws.send(
						JSON.stringify({
							type: 'initialState',
							gameCode: gameRoom.gameCode,
							gameRoomId: gameRoom._id,
							playerCount: gameRoom.playerCount,
							message:
								gameRoom.status === 'completed'
									? 'Game Over!'
									: canDraw
									? `Draw the ${
											segments[
												gameRoom.currentSegmentIndex
											]
									  }.`
									: 'Waiting for other players.',
							currentSegmentIndex: gameRoom.currentSegmentIndex,
							canDraw: canDraw,
							isWaitingForOthers: isWaitingForOthers,
							canvasData: initialCanvasData,
							status: gameRoom.status,
							finalArtwork: gameRoom.finalArtwork,
							playerId: ws.playerId,
						})
					);
					return;
				}

				// Limit players per room
				if (gameRoom.playerCount >= MAX_PLAYERS) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room is full.',
						})
					);
					return;
				}

				// Add player to the room
				console.log(
					`[JOIN GAME] Before adding player: gameRoom.playerCount = ${gameRoom.playerCount}`
				);
				gameRoom.players.push(ws.playerId);
				gameRoom.playerObjects.push({
					id: ws.playerId,
					name: playerName,
				});
				gameRoom.playerCount++; // This increments
				ws.gameRoomId = gameRoom._id.toHexString(); // Store gameRoomId on WebSocket client instance
				ws.playerName = playerName; // Store player name on WebSocket client instance

				console.log(
					`[JOIN GAME] After adding player (in memory): gameRoom.playerCount = ${gameRoom.playerCount}`
				);
				console.log(
					`[JOIN GAME] Updated players array (in memory): ${gameRoom.players.map(
						(p) => (p ? p.slice(0, 5) + '...' : 'null')
					)}`
				); // Log partial IDs and handle null/undefined

				// Update the game room in the database immediately
				const updateResult = await db
					.collection(COLLECTION_NAME)
					.updateOne(
						// Capture the result
						{ _id: gameRoom._id },
						{
							$set: {
								players: gameRoom.players,
								playerObjects: gameRoom.playerObjects,
								playerCount: gameRoom.playerCount,
							},
						}
					);
				console.log(
					`[JOIN GAME] DB update for player count result: Modified Count = ${updateResult.modifiedCount}`
				);

				// Fetch the game room again from DB to ensure latest state (optional, but good for debugging)
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: gameRoom._id });
				console.log(
					`[JOIN GAME] After DB update (refetched): gameRoom.playerCount = ${gameRoom.playerCount}, Status: ${gameRoom.status}`
				);

				// Check if game can start
				console.log(
					`[JOIN GAME] Evaluating game start: current playerCount=${gameRoom.playerCount}, MAX_PLAYERS=${MAX_PLAYERS}, current status='${gameRoom.status}'`
				);
				if (
					gameRoom.playerCount === MAX_PLAYERS &&
					gameRoom.status === 'waiting'
				) {
					console.log(
						'[JOIN GAME] CONDITION MET: Game is ready to start!'
					);
					gameRoom.status = 'playing';
					gameRoom.currentSegmentIndex = 0;
					gameRoom.currentTurn = 0; // First player draws head

					// Update status and turn in DB
					const gameStartUpdateResult = await db
						.collection(COLLECTION_NAME)
						.updateOne(
							{ _id: gameRoom._id },
							{
								$set: {
									status: gameRoom.status,
									currentSegmentIndex:
										gameRoom.currentSegmentIndex,
									currentTurn: gameRoom.currentTurn,
								},
							}
						);
					console.log(
						`[JOIN GAME] DB update for game start result: Modified Count = ${gameStartUpdateResult.modifiedCount}`
					);
					console.log(
						`[JOIN GAME] New gameRoom status (after start update): ${gameRoom.status}`
					);

					// Notify all players in the room that the game has started
					const initialCanvasData = null; // No peek for the first segment
					console.log(
						`[JOIN GAME] Broadcasting gameStarted to clients in room: ${gameRoom._id.toHexString()}`
					);
					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoom._id.toHexString()
						) {
							const canDraw =
								gameRoom.players[gameRoom.currentTurn] ===
								client.playerId;
							console.log(
								`[JOIN GAME - GAME STARTED] Sending to client ${client.playerId}: playerCount=${gameRoom.playerCount}, canDraw=${canDraw}`
							);
							client.send(
								JSON.stringify({
									type: 'gameStarted',
									message: `Game ${
										gameRoom.gameCode
									} started! Draw the ${
										segments[gameRoom.currentSegmentIndex]
									}.`,
									playerCount: gameRoom.playerCount,
									gameRoomId: gameRoom._id,
									currentSegmentIndex:
										gameRoom.currentSegmentIndex,
									canDraw: canDraw,
									isWaitingForOthers: false,
									canvasData: initialCanvasData,
									playerId: client.playerId,
								})
							);
						}
					});
				} else {
					console.log(
						`[JOIN GAME] Game not starting yet. Still waiting for players. Current players: ${gameRoom.playerCount}/${MAX_PLAYERS}`
					);
					// Game is still waiting for more players or is already playing (re-join scenario)
					const initialMessage = `Joined game ${gameCode}. Waiting for other players...`;
					const canDraw = false; // No one can draw if waiting for more players
					const isWaitingForOthers =
						gameRoom.playerCount < MAX_PLAYERS; // Everyone waits if not enough players
					const initialCanvasData = null;

					// Send initialState to all clients in the room (including the one that just joined)
					console.log(
						`[JOIN GAME] Broadcasting initialState to clients in room: ${gameRoom._id.toHexString()}`
					);
					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoom._id.toHexString()
						) {
							// Determine if this client is the one that just joined or an existing one
							const messageForClient =
								client.playerId === ws.playerId
									? initialMessage
									: `Player ${playerName} joined. Players: ${gameRoom.playerCount}/${MAX_PLAYERS}`;
							console.log(
								`[JOIN GAME - INITIAL STATE] Sending to client ${client.playerId}: playerCount=${gameRoom.playerCount}, message='${messageForClient}'`
							);
							client.send(
								JSON.stringify({
									type: 'initialState', // Keep sending initialState if not starting game
									gameCode: gameCode,
									gameRoomId: gameRoom._id,
									playerCount: gameRoom.playerCount,
									message: messageForClient,
									currentSegmentIndex:
										gameRoom.currentSegmentIndex,
									canDraw:
										gameRoom.playerCount === MAX_PLAYERS &&
										gameRoom.players[
											gameRoom.currentTurn
										] === client.playerId, // Only can draw if game started and it's their turn
									isWaitingForOthers:
										gameRoom.playerCount < MAX_PLAYERS, // Still waiting if not enough players
									canvasData: initialCanvasData,
									playerId: client.playerId,
								})
							);
						}
					});
				}
			} catch (error) {
				console.error('Error handling joinGame:', error);
				ws.send(
					JSON.stringify({
						type: 'error',
						message: 'Failed to join game.',
					})
				);
			}
			break;

		case 'submitSegment':
			try {
				if (!gameRoomId || !canvasData || !playerId) {
					console.error(
						'Invalid submission data: Missing gameRoomId, canvasData, or playerId.'
					);
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Invalid submission data.',
						})
					);
					return;
				}

				// Find the game room
				const gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(gameRoomId) });
				if (!gameRoom) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room not found.',
						})
					);
					return;
				}

				// Check if it's the correct player and turn
				if (gameRoom.players[gameRoom.currentTurn] !== playerId) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'It is not your turn.',
						})
					);
					return;
				}

				// Store the submitted segment
				// Create a temporary canvas with the peek from the previous segment for storage
				let peekCanvasData = null;
				if (gameRoom.canvasSegments.length > 0) {
					const lastSegment =
						gameRoom.canvasSegments[
							gameRoom.canvasSegments.length - 1
						];
					peekCanvasData = await createCanvasWithBottomPeek(
						lastSegment,
						CANVAS_WIDTH,
						CANVAS_HEIGHT,
						PEEK_HEIGHT
					);
				}

				// Store the full submitted drawing
				gameRoom.canvasSegments.push(canvasData);
				gameRoom.submittedPlayers.push(playerId); // Track who submitted

				// Update turn and check for next segment or game over
				gameRoom.currentTurn =
					(gameRoom.currentTurn + 1) % gameRoom.players.length;

				// Determine if all players have submitted for this round
				const allPlayersSubmitted =
					gameRoom.submittedPlayers.length === gameRoom.playerCount;

				if (
					allPlayersSubmitted &&
					gameRoom.canvasSegments.length < TOTAL_SEGMENTS
				) {
					// Start next segment for all players
					gameRoom.currentSegmentIndex++;
					gameRoom.submittedPlayers = []; // Reset for next round

					await db
						.collection(COLLECTION_NAME)
						.updateOne(
							{ _id: new ObjectId(gameRoomId) },
							{ $set: gameRoom }
						);

					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoomId
						) {
							const canDraw =
								gameRoom.players[gameRoom.currentTurn] ===
								client.playerId;
							client.send(
								JSON.stringify({
									type: 'nextSegment',
									message: `Game ${
										gameRoom.gameCode
									} - Draw the ${
										segments[gameRoom.currentSegmentIndex]
									}.`,
									playerCount: gameRoom.playerCount,
									currentSegmentIndex:
										gameRoom.currentSegmentIndex,
									canDraw: canDraw,
									isWaitingForOthers: false,
									gameRoomId: gameRoomId,
									canvasData: canDraw ? peekCanvasData : null, // Send peek data to the next player to draw
								})
							);
						}
					});
				} else if (
					allPlayersSubmitted &&
					gameRoom.canvasSegments.length === TOTAL_SEGMENTS
				) {
					// Game Over
					gameRoom.status = 'completed';
					const finalArtwork = await combineCanvases(
						gameRoom.canvasSegments
					);
					gameRoom.finalArtwork = finalArtwork;

					await db
						.collection(COLLECTION_NAME)
						.updateOne(
							{ _id: new ObjectId(gameRoomId) },
							{ $set: gameRoom }
						);

					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoomId
						) {
							client.send(
								JSON.stringify({
									type: 'gameOver',
									message:
										'Game Over! The exquisite corpse is complete!',
									finalArtwork: finalArtwork,
									gameRoomId: gameRoomId,
									playerCount: gameRoom.playerCount,
								})
							);
						}
					});
				} else {
					// Player submitted, waiting for others
					await db
						.collection(COLLECTION_NAME)
						.updateOne(
							{ _id: new ObjectId(gameRoomId) },
							{ $set: gameRoom }
						);

					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoomId
						) {
							const messageForClient =
								gameRoom.players[gameRoom.currentTurn] ===
								client.playerId
									? `It's your turn to draw the ${
											segments[
												gameRoom.currentSegmentIndex
											]
									  }. Waiting for others to submit.`
									: `Waiting for other players to submit their segments.`;

							client.send(
								JSON.stringify({
									type: 'waitingForOthers',
									message: messageForClient,
									playerCount: gameRoom.playerCount,
									currentSegmentIndex:
										gameRoom.currentSegmentIndex,
									canDraw:
										gameRoom.players[
											gameRoom.currentTurn
										] === client.playerId,
									isWaitingForOthers: true, // Tell client they are waiting
									gameRoomId: gameRoomId,
									canvasData: null, // No peek data until all submit and new round starts
								})
							);
						}
					});
				}
			} catch (error) {
				console.error('Error handling submitSegment:', error);
				ws.send(
					JSON.stringify({
						type: 'error',
						message: 'Failed to process submission.',
					})
				);
			}
			break;

		case 'requestGameState':
			try {
				// This is useful for players re-connecting or refreshing
				const gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ gameCode: gameCode });
				if (!gameRoom) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game not found.',
						})
					);
					return;
				}

				// Determine if this specific client can draw
				const canDraw =
					gameRoom.players[gameRoom.currentTurn] === ws.playerId;
				const isWaitingForOthers =
					gameRoom.status === 'playing' &&
					gameRoom.submittedPlayers.includes(ws.playerId);

				let currentCanvasData = null;
				if (gameRoom.currentSegmentIndex > 0) {
					// Send the peek from the last submitted segment
					const lastSegment =
						gameRoom.canvasSegments[
							gameRoom.canvasSegments.length - 1
						];
					currentCanvasData = await createCanvasWithBottomPeek(
						lastSegment,
						CANVAS_WIDTH,
						CANVAS_HEIGHT,
						PEEK_HEIGHT
					);
				} else if (
					gameRoom.status === 'completed' &&
					gameRoom.finalArtwork
				) {
					currentCanvasData = gameRoom.finalArtwork;
				}

				ws.send(
					JSON.stringify({
						type: 'initialState',
						gameCode: gameRoom.gameCode,
						gameRoomId: gameRoom._id,
						playerCount: gameRoom.playerCount,
						message: `Game ${gameRoom.gameCode} - ${
							gameRoom.status === 'completed'
								? 'Game Over!'
								: `Draw the ${
										segments[gameRoom.currentSegmentIndex]
								  }.`
						}`,
						currentSegmentIndex: gameRoom.currentSegmentIndex,
						canDraw: canDraw,
						isWaitingForOthers: isWaitingForOthers,
						canvasData: currentCanvasData,
						status: gameRoom.status,
						finalArtwork: gameRoom.finalArtwork,
						playerId: ws.playerId,
					})
				);
			} catch (error) {
				console.error('Error handling requestGameState:', error);
				ws.send(
					JSON.stringify({
						type: 'error',
						message: 'Failed to retrieve game state.',
					})
				);
			}
			break;

		default:
			ws.send(
				JSON.stringify({
					type: 'error',
					message: 'Unknown message type.',
				})
			);
			break;
	}
}

/**
 * Handles WebSocket close events.
 * @param {WebSocket} ws The WebSocket instance for the current client.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {Db} db The MongoDB database instance.
 */
async function handleWebSocketClose(ws, wss, db) {
	console.log(`Client ${ws.playerId} disconnected.`);

	// If the client was in a game room, update the game room status
	if (ws.gameRoomId) {
		try {
			let gameRoom = await db
				.collection(COLLECTION_NAME)
				.findOne({ _id: new ObjectId(ws.gameRoomId) });

			if (gameRoom) {
				const updatedPlayers = gameRoom.players.filter(
					(id) => id !== ws.playerId
				);
				const updatedPlayerObjects = gameRoom.playerObjects.filter(
					(obj) => obj.id !== ws.playerId
				);
				const newPlayerCount = updatedPlayers.length;

				// If all players have disconnected, delete the game room
				if (newPlayerCount === 0) {
					await db
						.collection(COLLECTION_NAME)
						.deleteOne({ _id: new ObjectId(ws.gameRoomId) });
					console.log(
						`Game room ${ws.gameRoomId} deleted as all players disconnected.`
					);
				} else {
					await db.collection(COLLECTION_NAME).updateOne(
						{ _id: new ObjectId(ws.gameRoomId) },
						{
							$set: {
								players: updatedPlayers,
								playerObjects: updatedPlayerObjects,
								playerCount: newPlayerCount,
								status: 'waiting', // Set status back to waiting if a player leaves
							},
						}
					);
					console.log(
						`Player disconnected from game room ${ws.gameRoomId}. Remaining players: ${newPlayerCount}`
					);
					// Notify remaining players in the room
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
									playerCount: newPlayerCount,
									canDraw: false, // Assume drawing is paused until new player joins
									isWaitingForOthers: false, // Not waiting for submission anymore
								})
							);
						}
					});
				}
			} else {
				console.log(
					`Disconnected client was in game room ${ws.gameRoomId}, but room not found.`
				);
			}
		} catch (error) {
			console.error('Error handling WebSocket close:', error);
		}
	}
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
