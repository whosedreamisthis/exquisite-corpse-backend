// game-handlers.js

const { ObjectId } = require('mongodb');
const WebSocket = require('ws');
const {
	combineCanvases,
	overlayCanvases,
	createCanvasWithBottomPeek,
} = require('./canvas-utils');

// --- Constants ---
const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4; // Head, Torso, Legs, Feet
const MAX_PLAYERS = 2; // For now, fixed at 2
const CANVAS_WIDTH = 800; // Assuming fixed canvas dimensions
const CANVAS_HEIGHT = 600;
const PEEK_HEIGHT = 100; // Height of the "peek" from the previous segment

// Segments for the game (Head, Torso, Legs, Feet)
const segments = ['Head', 'Torso', 'Legs', 'Feet'];

// Helper to create a blank canvas data URL
function createCanvas(width, height) {
	const { createCanvas } = require('canvas'); // Local import for this helper
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext('2d');
	ctx.clearRect(0, 0, width, height); // Ensure it's transparent
	return canvas;
}

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

					let initialCanvasData = null;
					// For re-joining, send the current canvas they are assigned to
					const assignedArtworkIndex =
						gameRoom.playerCanvasAssignments[ws.playerId];
					if (
						gameRoom.currentSegmentIndex > 0 &&
						assignedArtworkIndex !== undefined
					) {
						const currentArtworkSegments =
							gameRoom.artworks[assignedArtworkIndex].segments;
						const lastSegmentData =
							currentArtworkSegments[
								gameRoom.currentSegmentIndex - 1
							];
						if (lastSegmentData) {
							initialCanvasData =
								await createCanvasWithBottomPeek(
									lastSegmentData,
									CANVAS_WIDTH,
									CANVAS_HEIGHT,
									PEEK_HEIGHT
								);
						}
					} else if (gameRoom.status === 'completed') {
						// If game is over, send both final artworks
						ws.send(
							JSON.stringify({
								type: 'gameOver',
								finalArtworks: gameRoom.artworks.map(
									(a) => a.finalArtwork
								),
							})
						);
						return; // Exit as game is over and final artworks are sent separately
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
							canvasData: initialCanvasData, // This will be the peek for their assigned canvas
							status: gameRoom.status,
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
				console.log(
					`[JOIN GAME] Updated players array (in memory): ${gameRoom.players.map(
						(p) => (p ? p.slice(0, 5) + '...' : 'null')
					)}`
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

				// Fetch the game room again from DB to ensure latest state (optional, but good for debugging)
				gameRoom = await db.collection(COLLECTION_NAME).findOne({
					_id: gameRoom._id,
				});
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
					gameRoom.submittedPlayers = []; // Ensure empty for first segment
					gameRoom.currentSegmentSubmissions = {}; // Ensure empty for first segment

					// Assign initial canvases: Player 1 gets artwork 0, Player 2 gets artwork 1
					gameRoom.playerCanvasAssignments = {
						[gameRoom.players[0]]: 0, // Player 1 (first to join) draws on artwork 0
						[gameRoom.players[1]]: 1, // Player 2 (second to join) draws on artwork 1
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
									playerCanvasAssignments:
										gameRoom.playerCanvasAssignments, // Save assignments
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
					console.log(
						`[JOIN GAME] Broadcasting gameStarted to clients in room: ${gameRoom._id.toHexString()}`
					);
					for (const client of wss.clients) {
						// Changed to for...of loop
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoom._id.toHexString()
						) {
							// All players can draw the first segment (no peek yet)
							const canDraw = true;
							console.log(
								`[JOIN GAME - GAME STARTED] Sending to client ${client.playerId}: playerCount=${gameRoom.playerCount}, canDraw=${canDraw}`
							);
							client.send(
								JSON.stringify({
									type: 'gameStarted',
									message: getClientMessage(
										gameRoom,
										client.playerId
									),
									playerCount: gameRoom.playerCount,
									gameRoomId: gameRoom._id,
									currentSegmentIndex:
										gameRoom.currentSegmentIndex,
									canDraw: canDraw,
									isWaitingForOthers: false,
									canvasData: null, // No peek for the first segment
									playerId: client.playerId,
								})
							);
						}
					}
				} else {
					console.log(
						`[JOIN GAME] Game not starting yet. Still waiting for players. Current players: ${gameRoom.playerCount}/${MAX_PLAYERS}`
					);
					// Game is still waiting for more players or is already playing (re-join scenario)
					// Send initialState to all clients in the room (including the one that just joined)
					console.log(
						`[JOIN GAME] Broadcasting initialState to clients in room: ${gameRoom._id.toHexString()}`
					);
					for (const client of wss.clients) {
						// Changed to for...of loop
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoom._id.toHexString()
						) {
							const canDraw =
								gameRoom.status === 'playing' &&
								!gameRoom.submittedPlayers.includes(
									client.playerId
								);
							const isWaitingForOthers =
								gameRoom.status === 'playing' &&
								gameRoom.submittedPlayers.includes(
									client.playerId
								);

							let initialCanvasData = null;
							const assignedArtworkIndex =
								gameRoom.playerCanvasAssignments[
									client.playerId
								];
							if (
								gameRoom.currentSegmentIndex > 0 &&
								assignedArtworkIndex !== undefined
							) {
								const currentArtworkSegments =
									gameRoom.artworks[assignedArtworkIndex]
										.segments;
								const lastSegmentData =
									currentArtworkSegments[
										gameRoom.currentSegmentIndex - 1
									];
								if (lastSegmentData) {
									initialCanvasData =
										await createCanvasWithBottomPeek(
											lastSegmentData,
											CANVAS_WIDTH,
											CANVAS_HEIGHT,
											PEEK_HEIGHT
										);
								}
							}

							client.send(
								JSON.stringify({
									type: 'initialState',
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
									canvasData: initialCanvasData,
									status: gameRoom.status,
									playerId: client.playerId,
								})
							);
						}
					}
				}
			} catch (error) {
				console.error('Error joining game:', error);
				ws.send(
					JSON.stringify({
						type: 'error',
						message: `Failed to join game: ${error.message}`,
					})
				);
			}
			break;

		case 'submitSegment':
			try {
				if (!gameRoomId || !playerId || !canvasData) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Invalid submission data.',
						})
					);
					return;
				}

				let gameRoom = await db
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

				// Ensure player hasn't already submitted for this segment
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

				// Get the artwork index this player is currently assigned to
				const assignedArtworkIndex =
					gameRoom.playerCanvasAssignments[playerId];
				if (assignedArtworkIndex === undefined) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'No artwork assigned to you.',
						})
					);
					return;
				}

				// Store the submitted segment in the correct artwork's segments array
				gameRoom.artworks[assignedArtworkIndex].segments[
					gameRoom.currentSegmentIndex
				] = canvasData;

				// Add player to submitted list for this segment
				gameRoom.submittedPlayers.push(playerId);

				await db.collection(COLLECTION_NAME).updateOne(
					{ _id: new ObjectId(gameRoomId) },
					{
						$set: {
							submittedPlayers: gameRoom.submittedPlayers,
							[`artworks.${assignedArtworkIndex}.segments.${gameRoom.currentSegmentIndex}`]:
								canvasData, // Update specific segment
						},
					}
				);

				// Notify the current player that they are waiting
				ws.send(
					JSON.stringify({
						type: 'segmentSubmitted',
						message:
							'Waiting for other players to submit their segments.',
						canDraw: false,
						isWaitingForOthers: true,
					})
				);

				// Check if all players have submitted for the current segment
				if (gameRoom.submittedPlayers.length === MAX_PLAYERS) {
					console.log(
						`All players submitted for segment ${gameRoom.currentSegmentIndex}.`
					);
					const nextSegmentIndex = gameRoom.currentSegmentIndex + 1;
					const isGameOver = nextSegmentIndex >= TOTAL_SEGMENTS;

					let updateDoc = {
						currentSegmentIndex: nextSegmentIndex,
						submittedPlayers: [], // Reset for next segment
					};

					if (isGameOver) {
						updateDoc.status = 'completed';
						// Combine final artworks for both canvases
						for (let i = 0; i < gameRoom.artworks.length; i++) {
							const finalCombinedArtwork = await combineCanvases(
								gameRoom.artworks[i].segments
							);
							updateDoc[`artworks.${i}.finalArtwork`] =
								finalCombinedArtwork;
						}
					} else {
						// Swap player-canvas assignments for the next round
						const player1Id = gameRoom.players[0];
						const player2Id = gameRoom.players[1];
						const currentAssignment1 =
							gameRoom.playerCanvasAssignments[player1Id];
						const currentAssignment2 =
							gameRoom.playerCanvasAssignments[player2Id];

						updateDoc.playerCanvasAssignments = {
							[player1Id]: currentAssignment2, // Player 1 gets player 2's canvas
							[player2Id]: currentAssignment1, // Player 2 gets player 1's canvas
						};
					}

					await db
						.collection(COLLECTION_NAME)
						.updateOne(
							{ _id: new ObjectId(gameRoomId) },
							{ $set: updateDoc }
						);

					// Fetch updated game room to send correct state to clients
					gameRoom = await db
						.collection(COLLECTION_NAME)
						.findOne({ _id: new ObjectId(gameRoomId) });

					// Notify all clients in the room about the new state
					for (const client of wss.clients) {
						// Changed to for...of loop
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoomId
						) {
							const clientAssignedArtworkIndex =
								gameRoom.playerCanvasAssignments[
									client.playerId
								];
							let canvasDataForClient = null;

							if (
								!isGameOver &&
								gameRoom.currentSegmentIndex > 0
							) {
								const currentArtworkSegments =
									gameRoom.artworks[
										clientAssignedArtworkIndex
									].segments;
								const lastSegmentData =
									currentArtworkSegments[
										gameRoom.currentSegmentIndex - 1
									];

								if (lastSegmentData) {
									canvasDataForClient =
										await createCanvasWithBottomPeek(
											lastSegmentData,
											CANVAS_WIDTH,
											CANVAS_HEIGHT,
											PEEK_HEIGHT
										);
								}
							}

							const canDraw =
								!isGameOver &&
								!gameRoom.submittedPlayers.includes(
									client.playerId
								);
							const isWaitingForOthers =
								!isGameOver &&
								gameRoom.submittedPlayers.includes(
									client.playerId
								);

							if (isGameOver) {
								client.send(
									JSON.stringify({
										type: 'gameOver',
										message: getClientMessage(
											gameRoom,
											client.playerId
										),
										finalArtworks: gameRoom.artworks.map(
											(a) => a.finalArtwork
										), // Send both final artworks
										currentSegmentIndex:
											gameRoom.currentSegmentIndex,
									})
								);
							} else {
								client.send(
									JSON.stringify({
										type: 'segmentCompleted', // New event type for segment completion + round start
										message: getClientMessage(
											gameRoom,
											client.playerId
										),
										currentSegmentIndex:
											gameRoom.currentSegmentIndex,
										canDraw: canDraw,
										isWaitingForOthers: isWaitingForOthers,
										canvasData: canvasDataForClient, // This is the peek for the next segment
									})
								);
							}
						}
					}
				}
			} catch (error) {
				console.error('Error submitting segment:', error);
				ws.send(
					JSON.stringify({
						type: 'error',
						message: `Failed to submit segment: ${error.message}`,
					})
				);
			}
			break;

		case 'sendDrawingUpdate':
			// This part remains largely the same, as it's just broadcasting real-time drawing
			// It doesn't affect the game state directly, only visual updates.
			// However, ensure you are not broadcasting 'finalArtwork' here.
			if (gameRoomId) {
				wss.clients.forEach((client) => {
					if (
						client.readyState === WebSocket.OPEN &&
						client.gameRoomId === gameRoomId &&
						client.playerId !== ws.playerId // Don't send back to the sender
					) {
						client.send(
							JSON.stringify({
								type: 'drawingUpdate',
								canvasData: canvasData,
							})
						);
					}
				});
			}
			break;

		default:
			console.warn('Unknown message type:', type);
			break;
	}
}

async function handleWebSocketClose(ws, wss, db) {
	console.log(`Client disconnected. ID: ${ws.playerId}`);
	if (ws.gameRoomId) {
		try {
			let gameRoom = await db
				.collection(COLLECTION_NAME)
				.findOne({ _id: new ObjectId(ws.gameRoomId) });

			if (gameRoom) {
				// Remove disconnected player from the arrays
				const updatedPlayers = gameRoom.players.filter(
					(id) => id !== ws.playerId
				);
				const updatedPlayerObjects = gameRoom.playerObjects.filter(
					(obj) => obj.id !== ws.playerId
				);
				const newPlayerCount = updatedPlayers.length;

				// Reset submittedPlayers if the disconnected player had submitted
				const updatedSubmittedPlayers =
					gameRoom.submittedPlayers.filter(
						(id) => id !== ws.playerId
					);

				// Remove player's canvas assignment
				const updatedPlayerCanvasAssignments = {
					...gameRoom.playerCanvasAssignments,
				};
				delete updatedPlayerCanvasAssignments[ws.playerId];

				// If no players left, delete the game room
				if (newPlayerCount === 0) {
					await db
						.collection(COLLECTION_NAME)
						.deleteOne({ _id: new ObjectId(ws.gameRoomId) });
					console.log(
						`Game room ${ws.gameRoomId} deleted as all players disconnected.`
					);
				} else {
					// If game was 'playing' and a player disconnects, revert to 'waiting' state
					// This allows a new player to join and continue the game
					let status = gameRoom.status;
					if (status === 'playing') {
						status = 'waiting'; // Pause game, wait for another player
					}

					await db.collection(COLLECTION_NAME).updateOne(
						{ _id: new ObjectId(ws.gameRoomId) },
						{
							$set: {
								players: updatedPlayers,
								playerObjects: updatedPlayerObjects,
								playerCount: newPlayerCount,
								status: status, // Set status back to waiting
								submittedPlayers: updatedSubmittedPlayers, // Update in case player submitted
								playerCanvasAssignments:
									updatedPlayerCanvasAssignments, // Update assignments
							},
						}
					);
					console.log(
						`Player disconnected from game room ${ws.gameRoomId}. Remaining players: ${newPlayerCount}. Game status set to '${status}'.`
					);

					// Notify remaining players in the room
					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === ws.gameRoomId
						) {
							// Re-evaluate client's state after disconnect
							// The remaining player should now be in a 'waiting' state
							client.send(
								JSON.stringify({
									type: 'playerDisconnected',
									message: getClientMessage(
										{
											...gameRoom,
											status: status,
											submittedPlayers:
												updatedSubmittedPlayers,
										},
										client.playerId
									),
									playerCount: newPlayerCount,
									canDraw: false, // Assume drawing is paused until new player joins
									isWaitingForOthers: false, // Not waiting for submission anymore
									status: status,
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
