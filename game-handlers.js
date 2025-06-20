// game-handlers.js

const { ObjectId } = require('mongodb');
const WebSocket = require('ws'); // Ensure WebSocket is imported here
const { combineCanvases, overlayCanvases } = require('./canvas-utils'); // Import both combining functions

// --- Constants ---
const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4; // Define the total number of segments for the game
const CANVAS_WIDTH = 800; // Assuming fixed canvas dimensions
const CANVAS_HEIGHT = 600;

// Segments for the game (Head, Torso, Legs, Feet)
const segments = ['Head', 'Torso', 'Legs', 'Feet'];

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
		// Attempt to find game room by ID first if available, otherwise by code
		if (gameRoomId) {
			try {
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(gameRoomId) });
			} catch (err) {
				console.warn(
					`Invalid gameRoomId provided: ${gameRoomId}. Trying with gameCode.`
				);
				gameRoom = null; // Reset to null if ID is invalid
			}
		}
		if (!gameRoom && gameCode) {
			gameRoom = await db
				.collection(COLLECTION_NAME)
				.findOne({ gameCode: gameCode });
		}

		switch (type) {
			case 'joinGame':
				let isNewPlayer = false;

				if (gameRoom) {
					console.log(
						`Client ${ws.id} joining existing game room: ${gameCode}`
					);
					ws.gameRoomId = gameRoom._id.toString();

					const existingPlayer = gameRoom.players.find(
						(p) => p === ws.playerId
					); // Check if player ID exists
					if (!existingPlayer) {
						if (gameRoom.players.length < 2) {
							gameRoom.players.push(ws.playerId);
							isNewPlayer = true;
							// Add nickname if new player, or update if existing but no nickname
							const playerObj = {
								id: ws.playerId,
								nickname:
									nickname ||
									`Player_${ws.playerId.substring(0, 4)}`,
							};
							gameRoom.playerObjects = gameRoom.playerObjects
								? [...gameRoom.playerObjects, playerObj]
								: [playerObj];
						} else {
							ws.send(
								JSON.stringify({
									type: 'error',
									message: 'Game room is full.',
								})
							);
							return; // Exit if room is full
						}
					} else {
						// Player is rejoining, ensure their nickname is set if not already
						const playerObj = gameRoom.playerObjects.find(
							(p) => p.id === ws.playerId
						);
						if (playerObj && !playerObj.nickname && nickname) {
							playerObj.nickname = nickname;
							await db
								.collection(COLLECTION_NAME)
								.updateOne(
									{ _id: new ObjectId(ws.gameRoomId) },
									{
										$set: {
											playerObjects:
												gameRoom.playerObjects,
										},
									}
								);
						}
					}
				} else {
					// Create new game room
					console.log(
						`Client ${ws.id} creating new game room: ${gameCode}`
					);
					const newPlayerObj = {
						id: ws.playerId,
						nickname:
							nickname || `Player_${ws.playerId.substring(0, 4)}`,
					};
					const newGameRoom = {
						gameCode: gameCode,
						players: [ws.playerId], // Just IDs
						playerObjects: [newPlayerObj], // Objects with ID and nickname
						playerCount: 1,
						currentTurn: 0, // Player at index 0 starts (simplistic)
						canvasSegments: [], // Store canvas data URLs for each segment
						currentSegmentIndex: 0, // Start with the head
						submittedPlayers: [], // Track who has submitted for the current segment
						lastActivity: new Date(),
						status: 'waiting', // 'waiting', 'in-progress', 'completed'
					};
					const result = await db
						.collection(COLLECTION_NAME)
						.insertOne(newGameRoom);
					ws.gameRoomId = result.insertedId.toString();
					gameRoom = newGameRoom;
					console.log(
						`Backend: Created new game room ${gameCode} with ID ${ws.gameRoomId}`
					);
					isNewPlayer = true;
				}

				if (isNewPlayer) {
					// Update game room with new player
					await db.collection(COLLECTION_NAME).updateOne(
						{ _id: new ObjectId(ws.gameRoomId) },
						{
							$set: {
								players: gameRoom.players, // Update players array (IDs)
								playerObjects: gameRoom.playerObjects, // Update player objects
								playerCount: gameRoom.players.length,
								lastActivity: new Date(),
							},
						}
					);
				}

				// Re-fetch latest state of gameRoom after potential updates
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(ws.gameRoomId) });

				let initialCanvasData = null;
				if (gameRoom.currentSegmentIndex > 0) {
					// Collect all completed combined segments to show as background
					const completedCombinedSegments = gameRoom.canvasSegments
						.filter(
							(seg) =>
								seg.isCombined &&
								seg.segmentIndex < gameRoom.currentSegmentIndex
						)
						.sort((a, b) => a.segmentIndex - b.segmentIndex)
						.map((seg) => seg.dataUrl);

					if (completedCombinedSegments.length > 0) {
						try {
							initialCanvasData = await combineCanvases(
								completedCombinedSegments
							);
						} catch (combineErr) {
							console.error(
								'Error combining initial canvas for playerJoined:',
								combineErr
							);
						}
					}
				}

				wss.clients.forEach((client) => {
					if (
						client.readyState === WebSocket.OPEN &&
						client.gameRoomId === ws.gameRoomId
					) {
						let clientCanDraw = false;
						let clientIsWaitingForOthers = false;
						let messageForClient = '';

						if (gameRoom.playerCount < 2) {
							messageForClient = `Waiting for another player to join ${gameCode}...`;
							clientCanDraw = false;
							clientIsWaitingForOthers = false;
						} else if (gameRoom.status === 'completed') {
							messageForClient =
								'Game is over! View the final artwork.';
							clientCanDraw = false;
							clientIsWaitingForOthers = false;
						} else {
							// gameRoom.playerCount === 2 and status is 'in-progress' or about to be
							if (gameRoom.currentSegmentIndex === 0) {
								// For the Head segment, both players can draw simultaneously
								messageForClient = `Game ${gameCode} is ready! Draw the ${segments[0]}.`;
								clientCanDraw = true;
								clientIsWaitingForOthers = false;
							} else {
								// For subsequent segments
								// If this client has already submitted for the current segment, they wait.
								if (
									gameRoom.submittedPlayers.includes(
										client.playerId
									)
								) {
									messageForClient =
										'You have submitted your segment. Waiting for other players...';
									clientCanDraw = false;
									clientIsWaitingForOthers = true;
								} else {
									messageForClient = `It's your turn to draw the ${
										segments[gameRoom.currentSegmentIndex]
									}.`;
									clientCanDraw = true;
									clientIsWaitingForOthers = false;
								}
							}
						}

						client.send(
							JSON.stringify({
								type:
									gameRoom.playerCount === 2 &&
									gameRoom.currentSegmentIndex === 0 &&
									gameRoom.status === 'waiting'
										? 'gameStarted'
										: 'playerJoined', // Use gameStarted for initial start
								playerCount: gameRoom.playerCount,
								message: messageForClient,
								gameRoomId: gameRoom._id.toString(),
								currentSegmentIndex:
									gameRoom.currentSegmentIndex,
								canDraw: clientCanDraw, // Consistent name for frontend
								isWaitingForOthers: clientIsWaitingForOthers, // Consistent name for frontend
								canvasData: initialCanvasData, // Send combined background for ongoing games
							})
						);
					}
				});

				// If 2 players are now present and game was waiting, update status to in-progress
				if (
					gameRoom.playerCount === 2 &&
					gameRoom.status === 'waiting'
				) {
					await db
						.collection(COLLECTION_NAME)
						.updateOne(
							{ _id: new ObjectId(ws.gameRoomId) },
							{
								$set: {
									status: 'in-progress',
									currentSegmentIndex: 0,
								},
							}
						);
					console.log('Backend: Game status set to in-progress.');
				}
				break;

			case 'submitSegment':
				if (!ws.gameRoomId) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Not in a game room.',
						})
					);
					return;
				}
				if (!canvasData || segmentIndex === undefined) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Missing canvas data or segment index.',
						})
					);
					return;
				}

				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(ws.gameRoomId) });

				if (!gameRoom) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room not found.',
						})
					);
					return;
				}

				if (gameRoom.currentSegmentIndex !== segmentIndex) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message:
								'It is not the correct segment to submit for.',
						})
					);
					return;
				}

				if (gameRoom.submittedPlayers.includes(ws.playerId)) {
					ws.send(
						JSON.stringify({
							type: 'submissionReceived',
							message:
								'You have already submitted for this segment. Waiting for others.',
							canDraw: false,
							isWaitingForOthers: true,
						})
					);
					return;
				}

				const segmentEntry = {
					playerId: ws.playerId,
					segmentIndex: segmentIndex,
					dataUrl: canvasData,
					submittedAt: new Date(),
				};

				const updatedSubmittedPlayers = [
					...gameRoom.submittedPlayers,
					ws.playerId,
				];
				const updatedCanvasSegments = [
					...gameRoom.canvasSegments,
					segmentEntry,
				];

				await db.collection(COLLECTION_NAME).updateOne(
					{ _id: new ObjectId(ws.gameRoomId) },
					{
						$set: {
							canvasSegments: updatedCanvasSegments,
							submittedPlayers: updatedSubmittedPlayers,
							lastActivity: new Date(),
						},
					}
				);

				console.log(
					`Player ${ws.id} submitted segment ${segmentIndex} for game ${gameRoom.gameCode}.`
				);

				// Re-fetch updated game room after saving submission
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(ws.gameRoomId) });

				// Notify the submitting player
				ws.send(
					JSON.stringify({
						type: 'submissionReceived',
						message:
							'Your segment submitted. Waiting for other players.',
						canDraw: false, // Submitting player cannot draw
						isWaitingForOthers: true, // Submitting player is now waiting
					})
				);

				// Check if all players have submitted for the current segment
				if (gameRoom.submittedPlayers.length === gameRoom.playerCount) {
					console.log(
						`All players submitted for segment ${segmentIndex}.`
					);
					await advanceSegment(gameRoom._id, wss, db); // Pass db instance
				} else {
					// Notify other players that one has submitted (they can still draw)
					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === ws.gameRoomId &&
							client.playerId !== ws.playerId // Don't send back to self
						) {
							client.send(
								JSON.stringify({
									type: 'playerSubmitted',
									message:
										'Another player submitted their segment.',
									submittedCount:
										updatedSubmittedPlayers.length,
									totalPlayers: gameRoom.playerCount,
									// Other players should still be able to draw if they haven't submitted
									canDraw: true,
									isWaitingForOthers: false,
								})
							);
						}
					});
				}
				break;

			case 'requestInitialState': // For rejoining or refreshing
				if (!gameRoomId) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message:
								'No game room ID provided for initial state request.',
						})
					);
					return;
				}
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(gameRoomId) });

				if (gameRoom) {
					let clientCanDraw = false;
					let clientIsWaitingForOthers = false;
					let messageForClient = '';
					let currentCanvasData = null;

					if (gameRoom.currentSegmentIndex > 0) {
						const previousCombinedSegments = gameRoom.canvasSegments
							.filter(
								(seg) =>
									seg.isCombined &&
									seg.segmentIndex <
										gameRoom.currentSegmentIndex
							)
							.sort((a, b) => a.segmentIndex - b.segmentIndex)
							.map((seg) => seg.dataUrl);
						if (previousCombinedSegments.length > 0) {
							try {
								currentCanvasData = await combineCanvases(
									previousCombinedSegments
								);
							} catch (combineErr) {
								console.error(
									'Error combining previous segments for initial state:',
									combineErr
								);
							}
						}
					}

					if (gameRoom.playerCount < 2) {
						messageForClient = `Waiting for another player to join ${gameRoom.gameCode}...`;
						clientCanDraw = false;
						clientIsWaitingForOthers = false;
					} else if (gameRoom.status === 'completed') {
						messageForClient =
							'Game is over! View the final artwork.';
						clientCanDraw = false;
						clientIsWaitingForOthers = false;
						currentCanvasData = gameRoom.finalArtwork; // Send final artwork if game over
					} else {
						// 2 players, in-progress
						if (gameRoom.submittedPlayers.includes(ws.playerId)) {
							messageForClient =
								'You have submitted your segment. Waiting for other players...';
							clientCanDraw = false;
							clientIsWaitingForOthers = true;
						} else {
							messageForClient = `Game ${
								gameRoom.gameCode
							} is in progress. Draw the ${
								segments[gameRoom.currentSegmentIndex]
							}.`;
							clientCanDraw = true;
							clientIsWaitingForOthers = false;
						}
					}

					ws.send(
						JSON.stringify({
							type: 'playerJoined', // Re-use playerJoined to update state consistently on client
							gameCode: gameRoom.gameCode,
							gameRoomId: gameRoom._id.toString(),
							playerCount: gameRoom.playerCount,
							currentSegmentIndex: gameRoom.currentSegmentIndex,
							canDraw: clientCanDraw,
							isWaitingForOthers: clientIsWaitingForOthers,
							message: messageForClient,
							canvasData: currentCanvasData,
						})
					);
				} else {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room not found for initial state.',
						})
					);
				}
				break;

			case 'clearCanvas':
				// Clear the canvas for all players in the room
				if (!ws.gameRoomId) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Not in a game room.',
						})
					);
					return;
				}
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(ws.gameRoomId) });

				if (gameRoom) {
					// Reset canvasSegments and submittedPlayers for the current segment
					const updatedCanvasSegments =
						gameRoom.canvasSegments.filter(
							(seg) =>
								seg.segmentIndex !==
								gameRoom.currentSegmentIndex
						);

					await db
						.collection(COLLECTION_NAME)
						.updateOne(
							{ _id: new ObjectId(ws.gameRoomId) },
							{
								$set: {
									canvasSegments: updatedCanvasSegments,
									submittedPlayers: [],
									lastActivity: new Date(),
								},
							}
						);

					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === ws.gameRoomId
						) {
							client.send(
								JSON.stringify({
									type: 'clearCanvas',
									message:
										'Canvas cleared by host. Redraw your segment!',
									canvasData: null, // Ensure canvas is reset on frontend
									canDraw: true, // Enable drawing after clear
									isWaitingForOthers: false, // Not waiting
								})
							);
						}
					});
					console.log(
						`Canvas cleared for game ${gameRoom.gameCode} for segment ${gameRoom.currentSegmentIndex}.`
					);
				}
				break;

			default:
				console.warn('Unknown message type:', parsedMessage.type);
				break;
		}
	} catch (error) {
		console.error('Error handling WebSocket message:', error);
		ws.send(
			JSON.stringify({
				type: 'error',
				message: 'Server error processing message.',
			})
		);
	}
}

/**
 * Advances the game to the next segment or ends the game.
 * @param {ObjectId} gameRoomObjectId The MongoDB ObjectId of the game room.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {Db} db The MongoDB database instance. // Added db parameter
 */
async function advanceSegment(gameRoomObjectId, wss, db) {
	let gameRoom = await db
		.collection(COLLECTION_NAME)
		.findOne({ _id: gameRoomObjectId });

	if (!gameRoom) {
		console.error(
			`Game room ${gameRoomObjectId} not found for segment advancement.`
		);
		return;
	}

	// Get all canvas data URLs submitted for the segment that *just finished*
	const completedSegmentDrawings = gameRoom.canvasSegments
		.filter(
			(seg) =>
				seg.segmentIndex === gameRoom.currentSegmentIndex &&
				!seg.isCombined
		)
		.map((seg) => seg.dataUrl);

	let combinedCanvasForNextSegment = null;
	try {
		if (completedSegmentDrawings.length > 0) {
			combinedCanvasForNextSegment = await overlayCanvases(
				completedSegmentDrawings,
				CANVAS_WIDTH,
				CANVAS_HEIGHT
			);
			console.log(
				`Combined current segment (${gameRoom.currentSegmentIndex}) drawings.`
			);
		}
	} catch (combineErr) {
		console.error(
			`Error combining current segment ${gameRoom.currentSegmentIndex} drawings:`,
			combineErr
		);
		combinedCanvasForNextSegment = null;
	}

	// After combining the *current* segment's individual drawings, add it as a new "combined" entry
	if (combinedCanvasForNextSegment) {
		gameRoom.canvasSegments.push({
			segmentIndex: gameRoom.currentSegmentIndex, // This refers to the segment that was just completed
			dataUrl: combinedCanvasForNextSegment,
			isCombined: true, // Mark this as a combined segment
			createdAt: new Date(),
		});
	}

	gameRoom.currentSegmentIndex++; // Move to the next segment for drawing
	gameRoom.submittedPlayers = []; // Reset submitted players for the new segment

	if (gameRoom.currentSegmentIndex >= TOTAL_SEGMENTS) {
		// Game Over! Combine all combined segments into the final artwork
		gameRoom.status = 'completed';
		console.log(`Game ${gameRoom.gameCode} completed!`);

		const allCombinedSegments = gameRoom.canvasSegments
			.filter((seg) => seg.isCombined)
			.sort((a, b) => a.segmentIndex - b.segmentIndex)
			.map((seg) => seg.dataUrl);

		let finalArtworkData = null;
		try {
			// Combine all previous combined segments vertically for the final image
			finalArtworkData = await combineCanvases(allCombinedSegments);
			console.log(
				`Final artwork combined. Data URL length: ${
					finalArtworkData ? finalArtworkData.length : 0
				}`
			);
		} catch (finalCombineErr) {
			console.error('Error combining final artwork:', finalCombineErr);
		}

		await db.collection(COLLECTION_NAME).updateOne(
			{ _id: gameRoomObjectId },
			{
				$set: {
					currentSegmentIndex: gameRoom.currentSegmentIndex,
					submittedPlayers: gameRoom.submittedPlayers,
					lastActivity: new Date(),
					status: 'completed',
					finalArtwork: finalArtworkData, // Store the final image
					canvasSegments: gameRoom.canvasSegments, // Save updated segments with combined ones
				},
			}
		);

		wss.clients.forEach((client) => {
			if (
				client.readyState === WebSocket.OPEN &&
				client.gameRoomId === gameRoom._id.toString()
			) {
				client.send(
					JSON.stringify({
						type: 'gameOver',
						message: 'Game Over! The Exquisite Corpse is complete!',
						finalArtwork: finalArtworkData, // Send final artwork
						gameCode: gameRoom.gameCode,
						currentSegmentIndex: gameRoom.currentSegmentIndex,
						canDraw: false, // No drawing
						isWaitingForOthers: false, // No waiting
					})
				);
			}
		});
	} else {
		// Advance to next segment
		// Only get the *last* combined segment to show as background for the *next* drawing phase
		const lastCombinedSegmentData = gameRoom.canvasSegments
			.filter(
				(seg) =>
					seg.isCombined &&
					seg.segmentIndex === gameRoom.currentSegmentIndex - 1
			)
			.map((seg) => seg.dataUrl)[0];

		await db.collection(COLLECTION_NAME).updateOne(
			{ _id: gameRoomObjectId },
			{
				$set: {
					currentSegmentIndex: gameRoom.currentSegmentIndex,
					submittedPlayers: gameRoom.submittedPlayers,
					lastActivity: new Date(),
					status: 'in-progress', // Ensure status remains in-progress
					canvasSegments: gameRoom.canvasSegments, // Save updated segments with combined ones
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
						canvasData: lastCombinedSegmentData, // Send the combined previous segment as background
						message: `New segment started! Draw the ${
							segments[gameRoom.currentSegmentIndex]
						}.`,
						canDraw: true, // All players can draw again for the new segment
						isWaitingForOthers: false, // No longer waiting for previous segment submissions
					})
				);
				console.log(
					`Sent segmentAdvanced message to client ${
						client.id
					}. Canvas data sent: ${!!lastCombinedSegmentData}`
				);
			}
		});
	}
}

/**
 * Handles WebSocket client disconnections.
 * @param {WebSocket} ws The WebSocket instance for the current client.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {Db} db The MongoDB database instance.
 */
const handleWebSocketClose = async (ws, wss, db, error) => {
	// IMPORTANT: Now accepts 'db'
	console.log(`Client disconnected. ID: ${ws.id}`);
	if (error) {
		console.error('WebSocket error before close:', error);
	}

	// Add a check to ensure db is provided (for robustness)
	if (!db) {
		console.error(
			'Database instance not provided to handleWebSocketClose. Cannot update game room on disconnect.'
		);
		return;
	}

	if (ws.gameRoomId) {
		try {
			// Use the passed db parameter here
			const gameRoom = await db
				.collection(COLLECTION_NAME)
				.findOne({ _id: new ObjectId(ws.gameRoomId) });

			if (gameRoom) {
				const updatedPlayers = gameRoom.players.filter(
					(playerId) => playerId !== ws.playerId
				);
				// Also remove from playerObjects if you're using that for tracking
				const updatedPlayerObjects = gameRoom.playerObjects
					? gameRoom.playerObjects.filter(
							(obj) => obj.id !== ws.playerId
					  )
					: [];

				let newPlayerCount = updatedPlayers.length;
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
							},
						}
					);
					console.log(
						`Player disconnected from game room ${ws.gameRoomId}. Remaining players: ${newPlayerCount}`
					);
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
		} catch (err) {
			console.error('Error handling WebSocket close:', err);
		}
	} else {
		console.log('Disconnected client was not in a game room.');
	}
};

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
