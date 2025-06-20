// game-handlers.js

const { ObjectId } = require('mongodb');
const WebSocket = require('ws'); // Ensure WebSocket is imported here
const {
	combineCanvases,
	overlayCanvases, // Now using this for combining player submissions for a segment
	createCanvasWithBottomPeek,
} = require('./canvas-utils'); // Import new function

// --- Constants ---
const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4; // Define the total number of segments for the game
const MAX_PLAYERS = 2; // For now, fixed at 2
const CANVAS_WIDTH = 800; // Assuming fixed canvas dimensions
const CANVAS_HEIGHT = 600;
const PEEK_HEIGHT = 100; // Define the height of the "peek" from the previous segment

// Segments for the game (Head, Torso, Legs, Feet)
const segments = ['Head', 'Torso', 'Legs', 'Feet'];

// Helper to determine message for client based on game state
function getClientMessage(gameRoom, playerId) {
	if (gameRoom.status === 'completed') {
		return 'Game Over! The exquisite corpse is complete!';
	}
	if (gameRoom.status === 'waiting') {
		// THIS IS THE MESSAGE FOR A WAITING STATE
		return `Joined game ${gameRoom.gameCode}. Waiting for ${
			MAX_PLAYERS - gameRoom.playerCount
		} more player(s)...`;
	}

	// Game is 'playing'
	const hasSubmitted = gameRoom.submittedPlayers.includes(playerId);
	const segmentName = segments[gameRoom.currentSegmentIndex];

	if (hasSubmitted) {
		// THIS IS THE MESSAGE SHOWN
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
					if (gameRoom.currentSegmentIndex > 0) {
						// Send the combined previous segment as peek
						const lastCombinedSegment =
							gameRoom.canvasSegments[
								gameRoom.currentSegmentIndex - 1
							];
						initialCanvasData = await createCanvasWithBottomPeek(
							lastCombinedSegment,
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
							message: getClientMessage(gameRoom, ws.playerId),
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
					wss.clients.forEach(async (client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoom._id.toHexString()
						) {
							// All players can draw the first segment
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
					// Send initialState to all clients in the room (including the one that just joined)
					console.log(
						`[JOIN GAME] Broadcasting initialState to clients in room: ${gameRoom._id.toHexString()}`
					);
					wss.clients.forEach(async (client) => {
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

							let canvasDataForClient = null;
							if (gameRoom.currentSegmentIndex > 0) {
								const lastCombinedSegment =
									gameRoom.canvasSegments[
										gameRoom.currentSegmentIndex - 1
									];
								canvasDataForClient =
									canDraw || isWaitingForOthers
										? await createCanvasWithBottomPeek(
												lastCombinedSegment,
												CANVAS_WIDTH,
												CANVAS_HEIGHT,
												PEEK_HEIGHT
										  )
										: null;
							} else if (gameRoom.status === 'completed') {
								canvasDataForClient = gameRoom.finalArtwork;
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
									canvasData: canvasDataForClient,
									playerId: client.playerId,
									status: gameRoom.status, // Send current game status
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

				// Prevent re-submission for the current segment
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

				// Store the submitted segment for this player for the current round
				gameRoom.currentSegmentSubmissions[playerId] = canvasData;
				gameRoom.submittedPlayers.push(playerId); // Add player to submitted list for this round

				// Check if all players have submitted for this round
				const allPlayersSubmitted =
					gameRoom.submittedPlayers.length === gameRoom.playerCount;

				if (allPlayersSubmitted) {
					console.log(
						`[SUBMIT] All players submitted for segment ${gameRoom.currentSegmentIndex}.`
					);
					// Combine all individual submissions for the current segment
					const segmentCanvasesToOverlay = Object.values(
						gameRoom.currentSegmentSubmissions
					);
					const combinedSegmentArtwork = await overlayCanvases(
						segmentCanvasesToOverlay,
						CANVAS_WIDTH,
						CANVAS_HEIGHT
					);

					gameRoom.canvasSegments.push(combinedSegmentArtwork); // Add the combined segment to the history

					if (gameRoom.canvasSegments.length < TOTAL_SEGMENTS) {
						// Move to the next segment
						gameRoom.currentSegmentIndex++;
						gameRoom.submittedPlayers = []; // Reset for next round
						gameRoom.currentSegmentSubmissions = {}; // Reset submissions for next round
						gameRoom.status = 'playing'; // Ensure status is playing

						await db
							.collection(COLLECTION_NAME)
							.updateOne(
								{ _id: new ObjectId(gameRoomId) },
								{ $set: gameRoom }
							);

						// Prepare peek for the new segment
						const nextSegmentPeek =
							await createCanvasWithBottomPeek(
								combinedSegmentArtwork,
								CANVAS_WIDTH,
								CANVAS_HEIGHT,
								PEEK_HEIGHT
							);

						wss.clients.forEach((client) => {
							if (
								client.readyState === WebSocket.OPEN &&
								client.gameRoomId === gameRoomId
							) {
								console.log(
									`[SUBMIT] Broadcasting nextSegment to client ${client.playerId}`
								);
								client.send(
									JSON.stringify({
										type: 'nextSegment',
										message: getClientMessage(
											gameRoom,
											client.playerId
										),
										playerCount: gameRoom.playerCount,
										currentSegmentIndex:
											gameRoom.currentSegmentIndex,
										canDraw: true, // All players can draw the new segment
										isWaitingForOthers: false,
										gameRoomId: gameRoomId,
										canvasData: nextSegmentPeek, // Send peek data for the new segment
									})
								);
							}
						});
					} else {
						// Game Over - All segments completed
						gameRoom.status = 'completed';
						// Combine all combined segments for final artwork
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
								console.log(
									`[SUBMIT] Broadcasting gameOver to client ${client.playerId}`
								);
								client.send(
									JSON.stringify({
										type: 'gameOver',
										message: getClientMessage(
											gameRoom,
											client.playerId
										),
										finalArtwork: finalArtwork,
										gameRoomId: gameRoomId,
										playerCount: gameRoom.playerCount,
										currentSegmentIndex:
											gameRoom.currentSegmentIndex,
										canDraw: false,
										isWaitingForOthers: false,
									})
								);
							}
						});
					}
				} else {
					// Player submitted, waiting for others for the current segment
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
							const canDraw = !gameRoom.submittedPlayers.includes(
								client.playerId
							);
							const isWaitingForOthers =
								gameRoom.submittedPlayers.includes(
									client.playerId
								);
							console.log(
								`[SUBMIT] Broadcasting waitingForOthers to client ${client.playerId}`
							);
							client.send(
								JSON.stringify({
									type: 'waitingForOthers',
									message: getClientMessage(
										gameRoom,
										client.playerId
									),
									playerCount: gameRoom.playerCount,
									currentSegmentIndex:
										gameRoom.currentSegmentIndex,
									canDraw: canDraw,
									isWaitingForOthers: isWaitingForOthers,
									gameRoomId: gameRoomId,
									canvasData: null, // No new peek data until all submit and new round starts
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
					gameRoom.status === 'playing' &&
					!gameRoom.submittedPlayers.includes(ws.playerId);
				const isWaitingForOthers =
					gameRoom.status === 'playing' &&
					gameRoom.submittedPlayers.includes(ws.playerId);

				let currentCanvasData = null;
				if (gameRoom.currentSegmentIndex > 0) {
					// Send the combined previous segment as peek
					const lastCombinedSegment =
						gameRoom.canvasSegments[
							gameRoom.currentSegmentIndex - 1
						];
					currentCanvasData = await createCanvasWithBottomPeek(
						lastCombinedSegment,
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
						message: getClientMessage(gameRoom, ws.playerId),
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
 * Handles a WebSocket connection closing.
 * @param {WebSocket} ws The WebSocket instance that closed.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {Db} db The MongoDB database instance.
 */
async function handleWebSocketClose(ws, wss, db) {
	const gameRoomsCollection = db.collection(COLLECTION_NAME);

	console.log(
		`[WS-CLOSE] Client disconnected. ID: ${ws.playerId}, GameRoomId: ${ws.gameRoomId}`
	);

	if (ws.gameRoomId) {
		try {
			// Start of the try block
			let gameRoom = await gameRoomsCollection.findOne({
				_id: new ObjectId(ws.gameRoomId),
			});

			if (gameRoom) {
				// Remove the disconnected player from the gameRoom's players array
				gameRoom.players = gameRoom.players.filter(
					(id) => id !== ws.playerId
				);
				gameRoom.playerObjects = gameRoom.playerObjects.filter(
					(p) => p.id !== ws.playerId
				);

				// If the disconnected player had submitted for the current segment, remove their submission
				gameRoom.submittedPlayers = gameRoom.submittedPlayers.filter(
					(id) => id !== ws.playerId
				);
				delete gameRoom.currentSegmentSubmissions[ws.playerId];

				const newPlayerCount = gameRoom.players.length;
				console.log(
					`[WS-CLOSE] Player ${ws.playerId} removed from room ${ws.gameRoomId}. New player count: ${newPlayerCount}`
				);

				if (newPlayerCount === 0) {
					// No players left, delete the game room
					await gameRoomsCollection.deleteOne({
						_id: new ObjectId(ws.gameRoomId),
					});
					console.log(
						`Game room ${ws.gameRoomId} deleted as all players disconnected.`
					);
				} else {
					// Players remain, update the game room and notify others
					gameRoom.playerCount = newPlayerCount; // Update count
					// If game was playing and now only one player, revert to waiting
					if (
						gameRoom.status === 'playing' &&
						newPlayerCount < MAX_PLAYERS
					) {
						gameRoom.status = 'waiting'; // Set status back to waiting
						console.log(
							`[WS-CLOSE] Game room ${ws.gameRoomId} status set to 'waiting' due to player disconnect.`
						);
					}

					await gameRoomsCollection.updateOne(
						{ _id: new ObjectId(ws.gameRoomId) },
						{
							$set: {
								players: gameRoom.players,
								playerObjects: gameRoom.playerObjects,
								playerCount: newPlayerCount,
								status: gameRoom.status, // Update status in DB
								submittedPlayers: gameRoom.submittedPlayers, // Update in case player submitted
								currentSegmentSubmissions:
									gameRoom.currentSegmentSubmissions, // Update in case player submitted
							},
						}
					);
					console.log(
						`Player disconnected from game room ${ws.gameRoomId}. Remaining players: ${newPlayerCount}. Game status set to '${gameRoom.status}'.`
					);

					// Notify remaining players in the room
					// Refetch gameRoom to ensure accurate state for broadcasting after DB update
					gameRoom = await gameRoomsCollection.findOne({
						_id: new ObjectId(ws.gameRoomId),
					});

					wss.clients.forEach(async (client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === ws.gameRoomId
						) {
							// Re-evaluate client's state after disconnect based on actual gameRoom state
							const canDraw =
								gameRoom.status === 'playing' && // will be false if status is 'waiting'
								!gameRoom.submittedPlayers.includes(
									client.playerId
								);
							const isWaitingForOthers =
								gameRoom.status === 'playing' && // will be false if status is 'waiting'
								gameRoom.submittedPlayers.includes(
									client.playerId
								);

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
								})
							);
							console.log(
								`[WS-CLOSE] Sent playerDisconnected to ${client.playerId}. Status: ${gameRoom.status}, canDraw: ${canDraw}, isWaitingForOthers: ${isWaitingForOthers}`
							);
						}
					});
				}
			} else {
				// This else belongs to `if (gameRoom)`
				console.log(
					'Disconnected client was in a game room, but the room was not found in DB.'
				);
			}
		} catch (error) {
			// This catch belongs to the `try` block that started at the beginning of `if (ws.gameRoomId)`
			console.error('Error handling WebSocket close:', error);
		}
	} else {
		// This else belongs to `if (ws.gameRoomId)`
		console.log(
			'Disconnected client was not in a game room (gameRoomId was null).'
		);
	}
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
