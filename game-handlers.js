// game-handlers.js

const { ObjectId } = require('mongodb');
const WebSocket = require('ws');
const {
	combineCanvases,
	createCanvasWithBottomPeek,
	createBlankCanvas, // Import new function
} = require('./canvas-utils');

// --- Constants ---
const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4;
const MAX_PLAYERS = 2;
const CANVAS_WIDTH = 800; // Consistent with client and server
const CANVAS_HEIGHT = 600;
const PEEK_HEIGHT = 100;

// Segments for the game (Head, Torso, Legs, Feet)
const segments = ['Head', 'Torso', 'Legs', 'Feet'];

// Helper to determine message for client based on game state
function getClientMessage(gameRoom, playerId) {
	if (gameRoom.status === 'completed') {
		return 'Game Over! The exquisite corpse is complete!';
	}
	if (gameRoom.status === 'waiting') {
		return `Joined game ${gameRoom.gameCode}. Waiting for ${
			MAX_PLAYERS - gameRoom.playerCount
		} more player(s)...`;
	}

	// Game is 'playing'
	const hasSubmitted = gameRoom.submittedPlayers.includes(playerId);
	const segmentName = segments[gameRoom.currentSegmentIndex];

	if (hasSubmitted) {
		return 'Waiting for other players to submit their segments.';
	} else {
		return `Draw the ${segmentName}.`;
	}
}

/**
 * Handles incoming WebSocket messages, routing them to appropriate functions.
 * @param {WebSocket} ws The WebSocket instance for the current client.
 * @param {WebSocket.Server} wss The WebSocket server instance.
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
					ws.playerName = playerName;
					console.log(
						`[JOIN GAME] Player ${playerName} (${ws.playerId}) re-joined game ${gameCode}`
					);

					// Determine state for re-joining player
					const canDraw =
						gameRoom.status === 'playing' &&
						!gameRoom.submittedPlayers.includes(ws.playerId);
					const isWaitingForOthers =
						gameRoom.status === 'playing' &&
						gameRoom.submittedPlayers.includes(ws.playerId);

					let canvasDataToSend = null;
					let peekData = null;
					if (gameRoom.status === 'playing') {
						const assignedCanvasIndex =
							gameRoom.canvasAssignments[ws.playerId];
						canvasDataToSend =
							gameRoom.activeCanvasStates[assignedCanvasIndex];
						if (
							canvasDataToSend &&
							gameRoom.currentSegmentIndex > 0
						) {
							peekData = await createCanvasWithBottomPeek(
								canvasDataToSend,
								CANVAS_WIDTH,
								CANVAS_HEIGHT,
								PEEK_HEIGHT
							);
						}
					} else if (gameRoom.status === 'completed') {
						// Send final artworks if game over
						canvasDataToSend = gameRoom.finalArtworks[0]; // Just send one for re-connect, both sent below
					}

					ws.send(
						JSON.stringify({
							type: 'initialState',
							gameCode: gameRoom.gameCode,
							gameRoomId: gameRoom._id,
							playerCount: gameRoom.playerCount,
							message: getClientMessage(gameRoom, ws.playerId),
							currentSegmentIndex: gameRoom.currentSegmentIndex,
							canDraw: canDraw,
							isWaitingForOthers: isWaitingForOthers,
							canvasData: canvasDataToSend,
							peekData: peekData,
							status: gameRoom.status,
							finalArtwork1: gameRoom.finalArtworks[0] || null,
							finalArtwork2: gameRoom.finalArtworks[1] || null,
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
				gameRoom.playerCount++;
				ws.gameRoomId = gameRoom._id.toHexString(); // Store gameRoomId on WebSocket client instance
				ws.playerName = playerName; // Store player name on WebSocket client instance
				console.log(
					`[JOIN GAME] After adding player (in memory): gameRoom.playerCount = ${gameRoom.playerCount}`
				);

				// Update the game room in the database immediately
				const updateResult = await db
					.collection(COLLECTION_NAME)
					.updateOne(
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

				// Fetch the game room again from DB to ensure latest state
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: gameRoom._id });
				console.log(
					`[JOIN GAME] After DB update (refetched): gameRoom.playerCount = ${gameRoom.playerCount}, Status: ${gameRoom.status}`
				);

				// Check if game can start
				if (
					gameRoom.playerCount === MAX_PLAYERS &&
					gameRoom.status === 'waiting'
				) {
					console.log(
						'[JOIN GAME] CONDITION MET: Game is ready to start!'
					);
					gameRoom.status = 'playing';
					gameRoom.currentSegmentIndex = 0;
					gameRoom.submittedPlayers = []; // Ensure empty for first segment
					gameRoom.currentSegmentSubmissions = {}; // Ensure empty for first segment

					// Initialize canvas assignments for the first segment
					gameRoom.canvasAssignments = {
						[gameRoom.playerObjects[0].id]: 0, // Player 0 gets Canvas 0
						[gameRoom.playerObjects[1].id]: 1, // Player 1 gets Canvas 1
					};

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
									submittedPlayers: gameRoom.submittedPlayers,
									currentSegmentSubmissions:
										gameRoom.currentSegmentSubmissions,
									canvasAssignments:
										gameRoom.canvasAssignments,
								},
							}
						);
					console.log(
						`[JOIN GAME] Game started. DB update result: ${gameStartUpdateResult.modifiedCount}`
					);
				}

				// Broadcast updated state to all players in the room
				wss.clients.forEach(async (client) => {
					if (
						client.readyState === WebSocket.OPEN &&
						client.gameRoomId === gameRoom._id.toHexString()
					) {
						let canDraw = false;
						let isWaitingForOthers = false;
						let canvasDataToSend = null; // This will be the full canvas for the player to draw on
						let peekData = null; // This will be the peek image derived from canvasDataToSend
						let finalArtwork1 = null;
						let finalArtwork2 = null;

						if (gameRoom.status === 'playing') {
							canDraw = !gameRoom.submittedPlayers.includes(
								client.playerId
							);
							isWaitingForOthers =
								gameRoom.submittedPlayers.includes(
									client.playerId
								);

							// Get the canvas assigned to this player
							const assignedCanvasIndex =
								gameRoom.canvasAssignments[client.playerId];
							canvasDataToSend =
								gameRoom.activeCanvasStates[
									assignedCanvasIndex
								];

							// Generate peek from the canvas they are about to draw on (their current full canvas)
							if (
								canvasDataToSend &&
								gameRoom.currentSegmentIndex > 0
							) {
								// Only peek if not the very first segment
								peekData = await createCanvasWithBottomPeek(
									canvasDataToSend,
									CANVAS_WIDTH,
									CANVAS_HEIGHT,
									PEEK_HEIGHT
								);
							}
						} else if (gameRoom.status === 'completed') {
							// If game is completed, send final artworks
							if (
								gameRoom.finalArtworks &&
								gameRoom.finalArtworks.length > 0
							) {
								finalArtwork1 = gameRoom.finalArtworks[0];
								finalArtwork2 =
									gameRoom.finalArtworks[1] || null;
							}
						}

						console.log(
							`[JOIN GAME - INITIAL STATE] Sending to client ${
								client.playerId
							}: playerCount=${
								gameRoom.playerCount
							}, message='${getClientMessage(
								gameRoom,
								client.playerId
							)}'`
						);

						client.send(
							JSON.stringify({
								type: 'initialState',
								gameCode: gameCode,
								gameRoomId: gameRoom._id,
								playerCount: gameRoom.playerCount,
								message: getClientMessage(
									gameRoom,
									client.playerId
								),
								currentSegmentIndex:
									gameRoom.currentSegmentIndex,
								canDraw: canDraw,
								isWaitingForOthers: isWaitingForOthers,
								canvasData: canvasDataToSend, // Send the full canvas they should draw on
								peekData: peekData, // Send the peek for their current canvas
								status: gameRoom.status,
								finalArtwork1: finalArtwork1,
								finalArtwork2: finalArtwork2,
								playerId: client.playerId,
							})
						);
					}
				});
			} catch (error) {
				console.error('[JOIN GAME] Error:', error);
				ws.send(
					JSON.stringify({
						type: 'error',
						message: 'Failed to join game.',
					})
				);
			}
			break;

		case 'submitSegment':
			{
				const { gameRoomId, canvasData, playerId } = data;
				let gameRoom = await db.collection(COLLECTION_NAME).findOne({
					_id: new ObjectId(gameRoomId),
				});

				if (!gameRoom) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room not found.',
						})
					);
					return;
				}

				// Check if player has already submitted for this segment
				if (gameRoom.submittedPlayers.includes(playerId)) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message:
								'You have already submitted for this segment.',
						})
					);
					return;
				}

				// Update the assigned canvas with the new drawing
				const assignedCanvasIndex =
					gameRoom.canvasAssignments[playerId];
				gameRoom.activeCanvasStates[assignedCanvasIndex] = canvasData; // Store the updated full canvas

				gameRoom.submittedPlayers.push(playerId); // Mark player as submitted
				gameRoom.currentSegmentSubmissions[playerId] = canvasData; // This stores the *submitted full canvas* for reference

				console.log(
					`[SUBMIT] Player ${playerId} submitted for segment ${gameRoom.currentSegmentIndex}. Submitted players: ${gameRoom.submittedPlayers.length}`
				);

				let updates = {
					submittedPlayers: gameRoom.submittedPlayers,
					currentSegmentSubmissions:
						gameRoom.currentSegmentSubmissions,
					activeCanvasStates: gameRoom.activeCanvasStates, // Save updated canvas state
				};

				let isGameOver = false;

				// If both players have submitted for the current segment
				if (gameRoom.submittedPlayers.length === MAX_PLAYERS) {
					console.log(
						`[SUBMIT] Both players submitted for segment ${gameRoom.currentSegmentIndex}.`
					);

					// Check for game over
					if (gameRoom.currentSegmentIndex >= TOTAL_SEGMENTS - 1) {
						isGameOver = true;
						gameRoom.status = 'completed';
						updates.status = 'completed';
						console.log('[SUBMIT] Game is over!');

						// The final artworks are simply the two active canvases
						gameRoom.finalArtworks = gameRoom.activeCanvasStates;
						updates.finalArtworks = gameRoom.finalArtworks;
					} else {
						// Advance to the next segment
						gameRoom.currentSegmentIndex++;
						gameRoom.submittedPlayers = []; // Reset for next segment
						gameRoom.currentSegmentSubmissions = {}; // Reset for next segment

						// --- Perform Canvas Swap ---
						const player1Id = gameRoom.playerObjects[0].id;
						const player2Id = gameRoom.playerObjects[1].id;

						// Swap assignments for the next segment
						if (gameRoom.canvasAssignments[player1Id] === 0) {
							// If P1 had Canvas 0, P2 had Canvas 1
							gameRoom.canvasAssignments[player1Id] = 1; // P1 now gets Canvas 1
							gameRoom.canvasAssignments[player2Id] = 0; // P2 now gets Canvas 0
						} else {
							// If P1 had Canvas 1, P2 had Canvas 0
							gameRoom.canvasAssignments[player1Id] = 0; // P1 now gets Canvas 0
							gameRoom.canvasAssignments[player2Id] = 1; // P2 now gets Canvas 1
						}

						updates.currentSegmentIndex =
							gameRoom.currentSegmentIndex;
						updates.submittedPlayers = [];
						updates.currentSegmentSubmissions = {};
						updates.canvasAssignments = gameRoom.canvasAssignments; // Save updated assignments
					}
				}

				await db
					.collection(COLLECTION_NAME)
					.updateOne({ _id: gameRoom._id }, { $set: updates });

				// Re-fetch the updated gameRoom to broadcast the latest state
				gameRoom = await db.collection(COLLECTION_NAME).findOne({
					_id: new ObjectId(gameRoomId),
				});
				console.log(
					`[SUBMIT] Game room state after update: status=${gameRoom.status}, segment=${gameRoom.currentSegmentIndex}`
				);

				// Broadcast updated game state to all players in the room
				wss.clients.forEach(async (client) => {
					if (
						client.readyState === WebSocket.OPEN &&
						client.gameRoomId === gameRoom._id.toHexString()
					) {
						let canDraw = false;
						let isWaitingForOthers = false;
						let canvasDataToSend = null;
						let peekData = null;
						let finalArtwork1 = null;
						let finalArtwork2 = null;

						if (isGameOver) {
							canDraw = false;
							isWaitingForOthers = false;
							finalArtwork1 = gameRoom.finalArtworks[0];
							finalArtwork2 = gameRoom.finalArtworks[1] || null;
						} else {
							// Game is still playing or advanced segment
							canDraw = !gameRoom.submittedPlayers.includes(
								client.playerId
							);
							isWaitingForOthers =
								gameRoom.submittedPlayers.includes(
									client.playerId
								);

							// Get the canvas assigned to this player after the swap
							const assignedCanvasIndex =
								gameRoom.canvasAssignments[client.playerId];
							canvasDataToSend =
								gameRoom.activeCanvasStates[
									assignedCanvasIndex
								];

							// Generate peek from the canvas they are now assigned to
							if (
								canvasDataToSend &&
								gameRoom.currentSegmentIndex > 0
							) {
								// Only peek if not the very first segment
								peekData = await createCanvasWithBottomPeek(
									canvasDataToSend,
									CANVAS_WIDTH,
									CANVAS_HEIGHT,
									PEEK_HEIGHT
								);
							}
						}

						client.send(
							JSON.stringify({
								type: 'initialState', // Reuse initialState type for state updates
								gameCode: gameRoom.gameCode,
								gameRoomId: gameRoom._id,
								playerCount: gameRoom.playerCount,
								message: getClientMessage(
									gameRoom,
									client.playerId
								),
								currentSegmentIndex:
									gameRoom.currentSegmentIndex,
								canDraw: canDraw,
								isWaitingForOthers: isWaitingForOthers,
								canvasData: canvasDataToSend, // Send the full canvas they should draw on
								peekData: peekData, // Send the peek for their current canvas
								status: gameRoom.status,
								finalArtwork1: finalArtwork1,
								finalArtwork2: finalArtwork2,
								playerId: client.playerId,
							})
						);
					}
				});
			}
			break;

		default:
			console.warn(`Unknown message type: ${type}`);
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
 * @param {WebSocket} ws The WebSocket instance that closed.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {Db} db The MongoDB database instance.
 */
async function handleWebSocketClose(ws, wss, db) {
	console.log(`[WS-CLOSE] Client disconnected. ID: ${ws.playerId}`);
	if (ws.gameRoomId) {
		try {
			const gameRoomsCollection = db.collection(COLLECTION_NAME);
			let gameRoom = await gameRoomsCollection.findOne({
				_id: new ObjectId(ws.gameRoomId),
			});

			if (gameRoom) {
				// Remove the disconnected player from the gameRoom's players array and playerObjects
				const initialPlayerCount = gameRoom.playerCount;
				gameRoom.players = gameRoom.players.filter(
					(id) => id !== ws.playerId
				);
				gameRoom.playerObjects = gameRoom.playerObjects.filter(
					(p) => p.id !== ws.playerId
				);
				gameRoom.playerCount = gameRoom.players.length;

				// Reset game to waiting or end if all players leave
				let newStatus = gameRoom.status;
				let currentSegmentIndex = gameRoom.currentSegmentIndex;
				let submittedPlayers = gameRoom.submittedPlayers;
				let canvasAssignments = gameRoom.canvasAssignments;
				let activeCanvasStates = gameRoom.activeCanvasStates;
				let finalArtworks = gameRoom.finalArtworks;
				let currentSegmentSubmissions =
					gameRoom.currentSegmentSubmissions;

				if (
					gameRoom.playerCount < MAX_PLAYERS &&
					gameRoom.status === 'playing'
				) {
					newStatus = 'waiting'; // Go back to waiting if a player leaves during play
					// Optionally reset game state if a player leaves mid-game (e.g., currentSegmentIndex = 0)
					// For now, we'll just set status to waiting.
					console.log(
						`[WS-CLOSE] Game ${gameRoom.gameCode} status changed to 'waiting' due to player leaving.`
					);
				} else if (gameRoom.playerCount === 0) {
					newStatus = 'empty'; // Mark as empty if no players remain
					console.log(
						`[WS-CLOSE] Game ${gameRoom.gameCode} is now empty.`
					);
					// Consider deleting the room here, or setting a cleanup flag
					await gameRoomsCollection.deleteOne({
						_id: new ObjectId(ws.gameRoomId),
					});
					console.log(
						`[WS-CLOSE] Game room ${gameRoom.gameCode} deleted as it is empty.`
					);
					return; // No need to broadcast if room is deleted
				}

				const updateResult = await gameRoomsCollection.updateOne(
					{ _id: new ObjectId(ws.gameRoomId) },
					{
						$set: {
							players: gameRoom.players,
							playerObjects: gameRoom.playerObjects,
							playerCount: gameRoom.playerCount,
							status: newStatus,
							// Keep other state as is, or reset as per game design
							// currentSegmentIndex: currentSegmentIndex,
							// submittedPlayers: submittedPlayers,
							// ...
						},
					}
				);
				console.log(
					`[WS-CLOSE] DB update for disconnected player: Modified Count = ${updateResult.modifiedCount}`
				);

				// Re-fetch updated game room state to ensure accurate broadcast
				gameRoom = await gameRoomsCollection.findOne({
					_id: new ObjectId(ws.gameRoomId),
				});

				// Broadcast the updated player count and status to remaining players in the room
				const newPlayerCount = gameRoom ? gameRoom.playerCount : 0;
				wss.clients.forEach(async (client) => {
					if (
						client.readyState === WebSocket.OPEN &&
						client.gameRoomId === ws.gameRoomId && // Use ws.gameRoomId as it's the disconnected player's room
						client.playerId !== ws.playerId // Don't send to the disconnected client
					) {
						let canDraw = false;
						let isWaitingForOthers = false;
						let canvasDataToSend = null;
						let peekData = null;
						let finalArtwork1 = null;
						let finalArtwork2 = null;

						if (gameRoom.status === 'playing') {
							canDraw = !gameRoom.submittedPlayers.includes(
								client.playerId
							);
							isWaitingForOthers =
								gameRoom.submittedPlayers.includes(
									client.playerId
								);

							const assignedCanvasIndex =
								gameRoom.canvasAssignments[client.playerId];
							canvasDataToSend =
								gameRoom.activeCanvasStates[
									assignedCanvasIndex
								];
							if (
								canvasDataToSend &&
								gameRoom.currentSegmentIndex > 0
							) {
								peekData = await createCanvasWithBottomPeek(
									canvasDataToSend,
									CANVAS_WIDTH,
									CANVAS_HEIGHT,
									PEEK_HEIGHT
								);
							}
						} else if (gameRoom.status === 'completed') {
							finalArtwork1 = gameRoom.finalArtworks[0];
							finalArtwork2 = gameRoom.finalArtworks[1] || null;
						}

						client.send(
							JSON.stringify({
								type: 'playerDisconnected',
								// Use getClientMessage to generate the message based on the new gameRoom status
								message: getClientMessage(
									gameRoom,
									client.playerId
								),
								playerCount: newPlayerCount,
								canDraw: canDraw,
								isWaitingForOthers: isWaitingForOthers,
								status: gameRoom.status, // Send the updated game status
								gameRoomId: gameRoom._id.toHexString(), // Ensure gameRoomId is sent
								currentSegmentIndex:
									gameRoom.currentSegmentIndex, // Send current segment index
								canvasData: canvasDataToSend,
								peekData: peekData,
								finalArtwork1: finalArtwork1,
								finalArtwork2: finalArtwork2,
							})
						);
						console.log(
							`[WS-CLOSE] Sent playerDisconnected to ${client.playerId}. Status: ${gameRoom.status}, canDraw: ${canDraw}, isWaitingForOthers: ${isWaitingForOthers}`
						);
					}
				});
			} else {
				console.log(
					'Disconnected client was in a game room, but the room was not found in DB.'
				);
			}
		} catch (error) {
			console.error('Error handling WebSocket close:', error);
		}
	} else {
		console.log('Disconnected client was not in a game room.');
	}
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
