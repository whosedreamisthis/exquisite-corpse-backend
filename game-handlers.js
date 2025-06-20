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
const CANVAS_WIDTH = 800; // Assuming fixed canvas dimensions
const CANVAS_HEIGHT = 600;
const PEEK_HEIGHT = 100; // Define the height of the "peek" from the previous segment

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

// --- WebSocket Message Handler Functions ---

/**
 * Handles incoming WebSocket messages, routing them to appropriate functions.
 * @param {WebSocket} ws The WebSocket instance for the current client.
 * @param {WebSocket.Server} wss The WebSocket server instance.\
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
			canvasData, // Base64 data URL of the canvas
			playerId,
			playerName, // New: player name
		} = parsedMessage;

		let gameRoomObjectId;
		if (gameRoomId) {
			gameRoomObjectId = new ObjectId(gameRoomId);
		}

		switch (type) {
			case 'createGame':
				// ... (existing createGame logic)
				break;

			case 'joinGame':
				let gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ gameCode: gameCode.toUpperCase() });

				if (!gameRoom) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room not found.',
						})
					);
					return;
				}

				// Check if player already exists in the room
				const playerExists = gameRoom.players.includes(playerId);
				if (playerExists) {
					console.log(
						`Player ${playerId} rejoining existing session in game room ${gameCode}.`
					);
				} else if (gameRoom.playerCount >= 2) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room is full.',
						})
					);
					return;
				} else {
					gameRoom.players.push(playerId);
					gameRoom.playerObjects.push({
						id: playerId,
						name:
							playerName || `Player ${gameRoom.playerCount + 1}`,
					}); // Store player object
					gameRoom.playerCount++;
					await db.collection(COLLECTION_NAME).updateOne(
						{ _id: gameRoom._id },
						{
							$set: {
								players: gameRoom.players,
								playerObjects: gameRoom.playerObjects,
								playerCount: gameRoom.playerCount,
								lastActivity: new Date(),
							},
						}
					);
					console.log(
						`Player ${playerId} (${playerName}) joined game room ${gameCode}. Total players: ${gameRoom.playerCount}`
					);
				}

				ws.gameRoomId = gameRoom._id.toString(); // Attach gameRoomId to ws for easy lookup
				ws.playerId = playerId; // Attach playerId to ws

				let messageForClient = `Joined game ${gameCode}. Waiting for other players...`;
				let clientCanDraw = false;
				let clientIsWaitingForOthers = false;

				// Determine if this player can draw or if they are waiting
				if (gameRoom.playerCount === 2) {
					if (gameRoom.currentSegmentIndex === 0) {
						// Game starting, both players can draw segment 0
						messageForClient = `Game ${gameCode} started! Draw the ${segments[0]}.`;
						clientCanDraw = true;
						clientIsWaitingForOthers = false;
					} else {
						// Game in progress, check if this player has submitted for current segment
						const hasSubmitted =
							gameRoom.submittedPlayers.includes(playerId);
						clientCanDraw = !hasSubmitted;
						clientIsWaitingForOthers = hasSubmitted;
						messageForClient = hasSubmitted
							? `Waiting for others to submit segment ${
									segments[gameRoom.currentSegmentIndex]
							  }.`
							: `Draw the ${
									segments[gameRoom.currentSegmentIndex]
							  }.`;
					}
				}

				let initialCanvasData = null;
				// If this is not the very first segment and there are combined segments
				if (gameRoom.currentSegmentIndex > 0) {
					// Collect all *fully combined* segments up to the *previous* segment
					const completedCombinedSegmentsForPeek =
						gameRoom.canvasSegments
							.filter(
								(seg) =>
									seg.isCombined &&
									seg.segmentIndex <
										gameRoom.currentSegmentIndex // Get combined segments *before* the current drawing one
							)
							.sort((a, b) => a.segmentIndex - b.segmentIndex)
							.map((seg) => seg.dataUrl);

					if (completedCombinedSegmentsForPeek.length > 0) {
						try {
							// First, combine them all into one full image (this is the full drawing up to previous segment)
							const fullCombinedPreviousImage =
								await combineCanvases(
									completedCombinedSegmentsForPeek
								);
							// Then, create the 800x600 canvas with the peek at the bottom
							initialCanvasData =
								await createCanvasWithBottomPeek(
									fullCombinedPreviousImage,
									PEEK_HEIGHT,
									CANVAS_WIDTH,
									CANVAS_HEIGHT
								);
							console.log(
								`Generated initial peek canvas for playerJoined/gameStarted.`
							);
						} catch (combineErr) {
							console.error(
								'Error generating initial canvas with peek for playerJoined/gameStarted:',
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
						// Determine if client is the one that just joined or an existing one
						const isCurrentClient = client.playerId === ws.playerId;
						let clientCanDrawMsg = clientCanDraw;
						let clientIsWaitingForOthersMsg =
							clientIsWaitingForOthers;
						let messageForThisClient = messageForClient;

						if (!isCurrentClient) {
							// For other players already in the room, if current client just joined and started game
							if (
								gameRoom.playerCount === 2 &&
								gameRoom.currentSegmentIndex === 0
							) {
								clientCanDrawMsg = true;
								clientIsWaitingForOthersMsg = false;
								messageForThisClient = `Game ${gameCode} started! Draw the ${segments[0]}.`;
							}
							// If game in progress, check if the *other* client has already submitted
							if (
								gameRoom.currentSegmentIndex > 0 &&
								gameRoom.submittedPlayers.includes(
									client.playerId
								)
							) {
								clientCanDrawMsg = false;
								clientIsWaitingForOthersMsg = true;
								messageForThisClient = `Waiting for others to submit segment ${
									segments[gameRoom.currentSegmentIndex]
								}.`;
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
								message: messageForThisClient,
								gameRoomId: gameRoom._id.toString(),
								currentSegmentIndex:
									gameRoom.currentSegmentIndex,
								canDraw: clientCanDrawMsg, // Consistent name for frontend
								isWaitingForOthers: clientIsWaitingForOthersMsg, // Consistent name for frontend
								canvasData: initialCanvasData, // Send canvas with peek (or null for head)
							})
						);
					}
				});
				break;

			case 'submitSegment':
				if (!gameRoomObjectId || !playerId || !canvasData) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Invalid submission data.',
						})
					);
					return;
				}

				let roomToUpdate = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: gameRoomObjectId });

				if (!roomToUpdate) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room not found.',
						})
					);
					return;
				}

				if (roomToUpdate.submittedPlayers.includes(playerId)) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message:
								'You have already submitted for this segment.',
						})
					);
					return;
				}

				roomToUpdate.submittedPlayers.push(playerId);
				roomToUpdate.canvasSegments.push({
					segmentIndex: roomToUpdate.currentSegmentIndex,
					playerId: playerId,
					dataUrl: canvasData,
					isCombined: false, // Mark as an individual player drawing
					createdAt: new Date(),
				});

				await db.collection(COLLECTION_NAME).updateOne(
					{ _id: gameRoomObjectId },
					{
						$set: {
							submittedPlayers: roomToUpdate.submittedPlayers,
							canvasSegments: roomToUpdate.canvasSegments,
							lastActivity: new Date(),
						},
					}
				);

				console.log(
					`Player ${playerId} submitted segment ${roomToUpdate.currentSegmentIndex} for game ${roomToUpdate.gameCode}.`
				);

				// Notify submitting player they are waiting
				ws.send(
					JSON.stringify({
						type: 'submissionStatus',
						message: `Submitted! Waiting for others to finish segment ${
							segments[roomToUpdate.currentSegmentIndex]
						}.`,
						canDraw: false,
						isWaitingForOthers: true,
					})
				);

				// Check if all players have submitted for the current segment
				if (
					roomToUpdate.submittedPlayers.length ===
					roomToUpdate.playerCount
				) {
					console.log(
						`All players submitted for segment ${roomToUpdate.currentSegmentIndex}. Advancing segment...`
					);
					await advanceSegment(gameRoomObjectId, wss, db);
				} else {
					// If not all submitted, notify other players that one has submitted
					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoomObjectId.toString() &&
							client.playerId !== playerId
						) {
							client.send(
								JSON.stringify({
									type: 'playerSubmitted',
									message:
										'Another player has submitted their drawing!',
									canDraw: true, // They can still draw
									isWaitingForOthers: false,
								})
							);
						}
					});
				}
				break;

			case 'requestInitialState':
				if (!gameRoomObjectId) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message:
								'Game room ID missing for initial state request.',
						})
					);
					return;
				}

				let requestedGameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: gameRoomObjectId });

				if (!requestedGameRoom) {
					ws.send(
						JSON.stringify({
							type: 'error',
							message: 'Game room not found.',
						})
					);
					return;
				}

				// Determine if this player can draw or if they are waiting
				const hasSubmittedForCurrentSegment =
					requestedGameRoom.submittedPlayers.includes(playerId);
				const canDrawOnCanvas =
					requestedGameRoom.status === 'in-progress' &&
					!hasSubmittedForCurrentSegment;
				const isWaiting =
					requestedGameRoom.status === 'in-progress' &&
					hasSubmittedForCurrentSegment;

				let currentMessage;
				if (requestedGameRoom.status === 'completed') {
					currentMessage =
						'Game Over! The Exquisite Corpse is complete!';
				} else if (canDrawOnCanvas) {
					currentMessage = `Draw the ${
						segments[requestedGameRoom.currentSegmentIndex]
					}.`;
				} else if (isWaiting) {
					currentMessage = `Waiting for others to submit segment ${
						segments[requestedGameRoom.currentSegmentIndex]
					}.`;
				} else {
					currentMessage = `Waiting for another player to join or game to start.`;
				}

				let currentCanvasData = null; // This will become the canvas with peek
				if (requestedGameRoom.currentSegmentIndex > 0) {
					const previousCombinedSegmentsForPeek =
						requestedGameRoom.canvasSegments
							.filter(
								(seg) =>
									seg.isCombined &&
									seg.segmentIndex <
										requestedGameRoom.currentSegmentIndex
							)
							.sort((a, b) => a.segmentIndex - b.segmentIndex)
							.map((seg) => seg.dataUrl);

					if (previousCombinedSegmentsForPeek.length > 0) {
						try {
							const combinedPreviousFullImage =
								await combineCanvases(
									previousCombinedSegmentsForPeek
								);
							currentCanvasData =
								await createCanvasWithBottomPeek(
									combinedPreviousFullImage,
									PEEK_HEIGHT,
									CANVAS_WIDTH,
									CANVAS_HEIGHT
								);
							console.log(
								`Generated initial state canvas with peek.`
							);
						} catch (combineErr) {
							console.error(
								'Error generating canvas with peek for initial state:',
								combineErr
							);
						}
					}
				}
				// If game is over, ensure final artwork is sent, not a peek
				if (requestedGameRoom.status === 'completed') {
					currentCanvasData = requestedGameRoom.finalArtwork;
				}

				ws.send(
					JSON.stringify({
						type: 'initialState',
						gameCode: requestedGameRoom.gameCode,
						gameRoomId: requestedGameRoom._id.toString(),
						playerCount: requestedGameRoom.playerCount,
						currentSegmentIndex:
							requestedGameRoom.currentSegmentIndex,
						message: currentMessage,
						canDraw: canDrawOnCanvas,
						isWaitingForOthers: isWaiting,
						canvasData: currentCanvasData, // Send canvas with peek or final artwork
						finalArtwork: requestedGameRoom.finalArtwork || null, // Ensure final artwork is sent if game is over
					})
				);
				console.log(
					`Sent initial state to player ${playerId} for game ${requestedGameRoom.gameCode}.`
				);
				break;

			default:
				console.warn('Unknown message type:', type);
				break;
		}
	} catch (error) {
		console.error('WebSocket message handling error:', error);
		ws.send(
			JSON.stringify({
				type: 'error',
				message: 'Server error processing your request.',
			})
		);
	}
}

/**
 * Advances the game to the next segment after all players have submitted their drawings.
 * Combines player drawings for the just-finished segment and prepares the canvas for the next.
 * @param {ObjectId} gameRoomObjectId The ObjectId of the game room.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {Db} db The MongoDB database instance.
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

	// Get all canvas data URLs submitted for the segment that *just finished* (these are individual player drawings)
	const completedSegmentDrawings = gameRoom.canvasSegments
		.filter(
			(seg) =>
				seg.segmentIndex === gameRoom.currentSegmentIndex &&
				!seg.isCombined // Filter for individual drawings for the segment that just finished
		)
		.map((seg) => seg.dataUrl);

	let combinedSegmentOverlay = null; // This will be the overlaid result of the individual drawings for the finished segment
	try {
		if (completedSegmentDrawings.length > 0) {
			combinedSegmentOverlay = await overlayCanvases(
				completedSegmentDrawings,
				CANVAS_WIDTH,
				CANVAS_HEIGHT
			);
			console.log(
				`Combined current segment (${gameRoom.currentSegmentIndex}) drawings.`
			);
		} else {
			// If no drawings, ensure a blank canvas for this segment
			const emptyCanvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
			combinedSegmentOverlay = emptyCanvas.toDataURL();
		}
	} catch (overlayErr) {
		console.error(
			`Error overlaying current segment ${gameRoom.currentSegmentIndex} drawings:`,
			overlayErr
		);
		const emptyCanvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT); // Fallback to blank
		combinedSegmentOverlay = emptyCanvas.toDataURL();
	}

	// Add the newly combined (overlaid) segment as a 'combined' entry
	gameRoom.canvasSegments.push({
		segmentIndex: gameRoom.currentSegmentIndex, // This refers to the segment that was just completed
		dataUrl: combinedSegmentOverlay,
		isCombined: true, // Mark this as a combined segment
		createdAt: new Date(),
	});

	gameRoom.currentSegmentIndex++; // Move to the next segment for drawing
	gameRoom.submittedPlayers = []; // Reset submitted players for the new segment

	if (gameRoom.currentSegmentIndex >= TOTAL_SEGMENTS) {
		// Game Over! Combine all combined segments into the final artwork
		gameRoom.status = 'completed';
		console.log(`Game ${gameRoom.gameCode} completed!`);

		const allCombinedSegmentsForFinal = gameRoom.canvasSegments
			.filter((seg) => seg.isCombined)
			.sort((a, b) => a.segmentIndex - b.segmentIndex)
			.map((seg) => seg.dataUrl);

		let finalArtworkData = null;
		try {
			// Combine all previously 'isCombined' segments vertically for the final image
			finalArtworkData = await combineCanvases(
				allCombinedSegmentsForFinal
			);
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
		// Get all combined segments up to the *new current segment - 1* (i.e., the full drawing completed so far)
		const fullArtworkUpToPreviousSegment = gameRoom.canvasSegments
			.filter(
				(seg) =>
					seg.isCombined &&
					seg.segmentIndex < gameRoom.currentSegmentIndex
			) // Filter for combined segments *before* the new current segment
			.sort((a, b) => a.segmentIndex - b.segmentIndex)
			.map((seg) => seg.dataUrl);

		let canvasDataForNextSegment = null;
		try {
			if (fullArtworkUpToPreviousSegment.length > 0) {
				// First, combine all previous combined parts into one full image
				const combinedFullArtworkBeforeCurrent = await combineCanvases(
					fullArtworkUpToPreviousSegment
				);
				// Then, create the 800x600 canvas with the peek at the bottom
				canvasDataForNextSegment = await createCanvasWithBottomPeek(
					combinedFullArtworkBeforeCurrent,
					PEEK_HEIGHT,
					CANVAS_WIDTH,
					CANVAS_HEIGHT
				);
				console.log(
					`Generated peek canvas for segment ${gameRoom.currentSegmentIndex}.`
				);
			} else {
				// This case should only happen if currentSegmentIndex is 0 (Head), but logic is inside else for segment advancement
				// If somehow no previous combined segments (e.g., first segment draw after a clear/reset), send blank canvas
				const emptyCanvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
				canvasDataForNextSegment = emptyCanvas.toDataURL();
			}
		} catch (peekCreateErr) {
			console.error(
				'Error creating canvas with bottom peek:',
				peekCreateErr
			);
			const emptyCanvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT); // Fallback
			canvasDataForNextSegment = emptyCanvas.toDataURL();
		}

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
						canvasData: canvasDataForNextSegment, // Send the full canvas with the peek at the bottom
						message: `New segment started! Draw the ${
							segments[gameRoom.currentSegmentIndex]
						}.`,
						canDraw: true,
						isWaitingForOthers: false,
					})
				);
				console.log(
					`Sent segmentAdvanced message to client ${
						client.id
					}. Canvas data sent (canvas with peek): ${!!canvasDataForNextSegment}`
				);
			}
		});
	}
}

/**
 * Handles WebSocket client disconnections.
 * @param {WebSocket} ws The WebSocket instance for the disconnected client.
 * @param {WebSocket.Server} wss The WebSocket server instance.
 * @param {Db} db The MongoDB database instance.
 * @param {Error} [error] Optional error object if the close was due to an error.
 */
async function handleWebSocketClose(ws, wss, db, error) {
	if (error) {
		console.error('WebSocket error:', error);
	}
	console.log(`Client ${ws.id} disconnected.`);

	// If the client was in a game room, update the game room state
	if (ws.gameRoomId) {
		try {
			const gameRoom = await db
				.collection(COLLECTION_NAME)
				.findOne({ _id: new ObjectId(ws.gameRoomId) });

			if (gameRoom) {
				const updatedPlayers = gameRoom.players.filter(
					(id) => id !== ws.playerId
				);
				const updatedPlayerObjects = gameRoom.playerObjects.filter(
					(player) => player.id !== ws.playerId
				);
				const newPlayerCount = updatedPlayers.length;

				// If no players left, delete the game room
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
			console.error('Error handling client disconnection:', err);
		}
	}
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
