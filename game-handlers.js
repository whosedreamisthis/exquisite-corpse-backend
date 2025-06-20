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
	const currentPlayerObject = gameRoom.playerObjects.find(
		(p) => p.id === playerId
	);
	const otherPlayerObject = gameRoom.playerObjects.find(
		(p) => p.id !== playerId
	);

	if (gameRoom.playerCount < MAX_PLAYERS) {
		return `Joined game ${gameRoom.gameCode}. Waiting for ${
			MAX_PLAYERS - gameRoom.playerCount
		} more player(s)...`;
	}

	// Determine whose turn it is
	const isCurrentPlayerTurn =
		gameRoom.submittedPlayers.includes(playerId) === false; // If player hasn't submitted yet

	if (
		gameRoom.currentSegmentIndex === TOTAL_SEGMENTS &&
		gameRoom.status === 'completed'
	) {
		return 'Game Over! The exquisite corpse is complete!';
	}

	if (isCurrentPlayerTurn) {
		return `Your turn to draw the ${
			segments[gameRoom.currentSegmentIndex]
		}!`;
	} else {
		return `Waiting for ${
			otherPlayerObject ? otherPlayerObject.name : 'the other player'
		} to draw the ${segments[gameRoom.currentSegmentIndex]}...`;
	}
}

// --- WebSocket Message Handler ---
async function handleWebSocketMessage(ws, wss, db, message) {
	const gameRoomsCollection = db.collection(COLLECTION_NAME);
	const data = JSON.parse(message);

	console.log(
		`[WS] Received message of type: ${data.type} from ${ws.playerId}`
	);

	try {
		switch (data.type) {
			case 'createGame':
				// This case might not be strictly needed if game creation is purely via HTTP POST,
				// but included for completeness if a direct WS create was desired.
				// For now, createGame is handled via HTTP POST and then joinGame via WS.
				break;

			case 'joinGame':
				{
					const gameCode = data.gameCode.toUpperCase();
					const playerName =
						data.playerName ||
						`Player ${ws.playerId.substring(0, 4)}`;

					let gameRoom = await gameRoomsCollection.findOne({
						gameCode: gameCode,
					});

					if (!gameRoom) {
						// This should ideally not happen if createGame is called first
						// but handle gracefully.
						ws.send(
							JSON.stringify({
								type: 'error',
								message:
									'Game not found. Please create a new game.',
							})
						);
						return;
					}

					// Assign gameRoomId and playerName to the WebSocket connection
					ws.gameRoomId = gameRoom._id.toHexString();
					ws.playerName = playerName; // Store player name on WS object

					// If player is already in the room (e.g., re-connecting), update their WS ID if needed
					const existingPlayerIndex = gameRoom.players.indexOf(
						data.playerId
					); // data.playerId is from client, ws.playerId is from current WS
					if (
						existingPlayerIndex !== -1 &&
						data.playerId === ws.playerId
					) {
						console.log(
							`[JOIN GAME] Player ${ws.playerId} is re-joining.`
						);
						// Update client's WS object if needed, ensure gameRoomId is set
						ws.gameRoomId = gameRoom._id.toHexString();
						// Send current game state to the re-joining player
						const canDraw = gameRoom.playerObjects.some(
							(p) =>
								p.id === ws.playerId &&
								!gameRoom.submittedPlayers.includes(ws.playerId)
						);
						const isWaitingForOthers =
							gameRoom.submittedPlayers.includes(ws.playerId);

						let previousDrawingPeek = null;
						if (gameRoom.currentSegmentIndex > 0) {
							// For re-joining player, find their canvas and generate the peek
							const playerArtworks = gameRoom.artworks.find(
								(art) => art.playerId === ws.playerId
							);
							if (
								playerArtworks &&
								playerArtworks.segments[
									gameRoom.currentSegmentIndex - 1
								]
							) {
								// Get the previous segment's full drawing
								const fullPreviousDrawing =
									playerArtworks.segments[
										gameRoom.currentSegmentIndex - 1
									];
								previousDrawingPeek =
									await createCanvasWithBottomPeek(
										fullPreviousDrawing,
										CANVAS_WIDTH,
										CANVAS_HEIGHT,
										PEEK_HEIGHT
									);
							}
						}

						// If game is completed, send final artworks
						let finalArtwork = null;
						let finalArtwork2 = null;
						if (
							gameRoom.status === 'completed' &&
							gameRoom.finalArtworks &&
							gameRoom.finalArtworks.length > 0
						) {
							finalArtwork = gameRoom.finalArtworks[0];
							finalArtwork2 = gameRoom.finalArtworks[1] || null; // Get the second artwork if available
						}

						ws.send(
							JSON.stringify({
								type: 'initialState',
								gameCode: gameRoom.gameCode,
								gameRoomId: gameRoom._id.toHexString(),
								playerCount: gameRoom.playerCount,
								message: getClientMessage(
									gameRoom,
									ws.playerId
								),
								currentSegmentIndex:
									gameRoom.currentSegmentIndex,
								canDraw: canDraw,
								isWaitingForOthers: isWaitingForOthers,
								canvasData: previousDrawingPeek,
								status: gameRoom.status,
								finalArtwork: finalArtwork,
								finalArtwork2: finalArtwork2, // Send the second artwork
							})
						);
						return; // Stop further processing for re-joining player
					}

					// If game room is full and player is not re-joining
					if (
						gameRoom.playerCount >= MAX_PLAYERS &&
						existingPlayerIndex === -1
					) {
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
					ws.gameRoomId = gameRoom._id.toHexString(); // Ensure gameRoomId is set on ws
					ws.playerName = playerName;

					console.log(
						`[JOIN GAME] After adding player (in memory): gameRoom.playerCount = ${gameRoom.playerCount}`
					);
					await gameRoomsCollection.updateOne(
						{ _id: gameRoom._id },
						{
							$set: {
								players: gameRoom.players,
								playerObjects: gameRoom.playerObjects,
								playerCount: gameRoom.playerCount,
								status:
									gameRoom.playerCount === MAX_PLAYERS
										? 'playing'
										: 'waiting',
							},
						}
					);

					// Fetch the game room again from DB to ensure latest state (optional, but good for debugging)
					gameRoom = await gameRoomsCollection.findOne({
						_id: gameRoom._id,
					});
					console.log(
						`[JOIN GAME] After DB update (refetched): gameRoom.playerCount = ${gameRoom.playerCount}, Status: ${gameRoom.status}`
					);
					console.log(
						`[DEBUG] Player count after refetch: ${gameRoom.playerCount}`
					);

					// Broadcast updated state to all players in the room
					wss.clients.forEach(async (client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoom._id.toHexString()
						) {
							let canDraw = false;
							let isWaitingForOthers = false;
							let canvasData = null; // Canvas data for the peek
							let finalArtwork = null;
							let finalArtwork2 = null; // Second artwork for game over

							if (gameRoom.status === 'playing') {
								// In 'playing' state, determine who can draw and if peek image is needed
								if (gameRoom.currentSegmentIndex === 0) {
									// For the first segment, only the first player in playerObjects array draws
									// And only if they haven't submitted yet
									canDraw =
										gameRoom.playerObjects[0]?.id ===
											client.playerId &&
										!gameRoom.submittedPlayers.includes(
											client.playerId
										);
									isWaitingForOthers =
										gameRoom.playerObjects[0]?.id !==
											client.playerId &&
										gameRoom.submittedPlayers.length === 0; // Only waiting if P0 hasn't submitted
								} else {
									// For subsequent segments, determine turn based on who submitted last or next up
									const currentPlayerTurn =
										gameRoom.playerObjects.find(
											(p) =>
												!gameRoom.submittedPlayers.includes(
													p.id
												) && p.id === client.playerId
										);
									canDraw = !!currentPlayerTurn;
									isWaitingForOthers = !canDraw;

									// Generate peek for the current player based on the *other* player's previous submission
									if (gameRoom.currentSegmentIndex > 0) {
										const otherPlayerId =
											gameRoom.playerObjects.find(
												(p) => p.id !== client.playerId
											)?.id;

										const otherPlayerArtwork =
											gameRoom.artworks.find(
												(art) =>
													art.playerId ===
													otherPlayerId
											);

										if (
											otherPlayerArtwork &&
											otherPlayerArtwork.segments[
												gameRoom.currentSegmentIndex - 1
											]
										) {
											const fullPreviousDrawing =
												otherPlayerArtwork.segments[
													gameRoom.currentSegmentIndex -
														1
												];
											canvasData =
												await createCanvasWithBottomPeek(
													fullPreviousDrawing,
													CANVAS_WIDTH,
													CANVAS_HEIGHT,
													PEEK_HEIGHT
												);
										}
									}
								}
							} else if (gameRoom.status === 'completed') {
								// If game is completed, send final artworks
								if (
									gameRoom.finalArtworks &&
									gameRoom.finalArtworks.length > 0
								) {
									finalArtwork = gameRoom.finalArtworks[0];
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
							console.log(
								`[DEBUG] Player count sent to client ${client.playerId}: ${gameRoom.playerCount}`
							);

							client.send(
								JSON.stringify({
									type: 'initialState', // Or 'gameStarted' if status is playing
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
									canvasData: canvasData, // Send peek data if available
									status: gameRoom.status,
									finalArtwork: finalArtwork, // Send final artwork if game over
									finalArtwork2: finalArtwork2, // Send second final artwork if game over
								})
							);
						}
					});
				}
				break;

			case 'submitSegment':
				{
					const { gameRoomId, canvasData, playerId } = data;
					let gameRoom = await gameRoomsCollection.findOne({
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

					gameRoom.submittedPlayers.push(playerId); // Mark player as submitted
					gameRoom.currentSegmentSubmissions[playerId] = canvasData; // Store their submission

					console.log(
						`[SUBMIT] Player ${playerId} submitted for segment ${gameRoom.currentSegmentIndex}. Submitted players: ${gameRoom.submittedPlayers.length}`
					);

					let updates = {
						submittedPlayers: gameRoom.submittedPlayers,
						currentSegmentSubmissions:
							gameRoom.currentSegmentSubmissions,
					};

					let advanceSegment = false;
					let isGameOver = false;

					// If both players have submitted for the current segment
					if (gameRoom.submittedPlayers.length === MAX_PLAYERS) {
						console.log(
							`[SUBMIT] Both players submitted for segment ${gameRoom.currentSegmentIndex}.`
						);

						// Store individual segment submissions in each player's artwork array
						// Ensure 'artworks' array exists and has entries for each player
						if (
							!gameRoom.artworks ||
							gameRoom.artworks.length === 0
						) {
							gameRoom.artworks = gameRoom.playerObjects.map(
								(p) => ({
									playerId: p.id,
									segments: Array(TOTAL_SEGMENTS).fill(null), // Initialize with nulls
								})
							);
						}

						// For each player, find their artwork entry and save their submission
						for (const p of gameRoom.playerObjects) {
							const artworkEntry = gameRoom.artworks.find(
								(art) => art.playerId === p.id
							);
							if (artworkEntry) {
								artworkEntry.segments[
									gameRoom.currentSegmentIndex
								] = gameRoom.currentSegmentSubmissions[p.id];
							} else {
								console.error(
									`[SUBMIT] Could not find artwork entry for player ${p.id}`
								);
							}
						}

						// If all segments are complete
						if (
							gameRoom.currentSegmentIndex >=
							TOTAL_SEGMENTS - 1
						) {
							isGameOver = true;
							gameRoom.status = 'completed';
							updates.status = 'completed';
							console.log('[SUBMIT] Game is over!');

							// Combine final artworks for each player
							gameRoom.finalArtworks = [];
							for (const artwork of gameRoom.artworks) {
								if (
									artwork.segments &&
									artwork.segments.length > 0
								) {
									const combined = await combineCanvases(
										artwork.segments.filter(
											(s) => s !== null
										)
									);
									gameRoom.finalArtworks.push(combined);
								} else {
									gameRoom.finalArtworks.push(''); // Push empty if no segments
								}
							}
							updates.finalArtworks = gameRoom.finalArtworks;
						} else {
							// Advance to the next segment
							advanceSegment = true;
							gameRoom.currentSegmentIndex++;
							gameRoom.submittedPlayers = []; // Reset for next segment
							gameRoom.currentSegmentSubmissions = {}; // Reset for next segment
							updates.currentSegmentIndex =
								gameRoom.currentSegmentIndex;
							updates.submittedPlayers = [];
							updates.currentSegmentSubmissions = {};
							console.log(
								`[SUBMIT] Advancing to segment ${gameRoom.currentSegmentIndex}`
							);
						}

						updates.artworks = gameRoom.artworks; // Save updated artworks array
					}

					await gameRoomsCollection.updateOne(
						{ _id: gameRoom._id },
						{ $set: updates }
					);

					// Re-fetch the updated gameRoom to broadcast the latest state
					gameRoom = await gameRoomsCollection.findOne({
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
							let canvasData = null; // For peek
							let finalArtwork = null;
							let finalArtwork2 = null;

							if (isGameOver) {
								canDraw = false;
								isWaitingForOthers = false;
								finalArtwork = gameRoom.finalArtworks[0];
								finalArtwork2 =
									gameRoom.finalArtworks[1] || null; // Send second artwork
							} else if (advanceSegment) {
								// Determine who draws next based on player order and current segment
								const expectedDrawerId =
									gameRoom.playerObjects[
										gameRoom.currentSegmentIndex %
											MAX_PLAYERS
									].id;
								canDraw = client.playerId === expectedDrawerId;
								isWaitingForOthers =
									client.playerId !== expectedDrawerId;

								// Generate peek for the current player (based on OTHER player's last submission)
								// It will be the other player's submission for the *previous* segment
								if (gameRoom.currentSegmentIndex > 0) {
									const otherPlayerId =
										gameRoom.playerObjects.find(
											(p) => p.id !== client.playerId
										)?.id;
									const otherPlayerArtwork =
										gameRoom.artworks.find(
											(art) =>
												art.playerId === otherPlayerId
										);

									if (
										otherPlayerArtwork &&
										otherPlayerArtwork.segments[
											gameRoom.currentSegmentIndex - 1
										]
									) {
										const fullPreviousDrawing =
											otherPlayerArtwork.segments[
												gameRoom.currentSegmentIndex - 1
											];
										canvasData =
											await createCanvasWithBottomPeek(
												fullPreviousDrawing,
												CANVAS_WIDTH,
												CANVAS_HEIGHT,
												PEEK_HEIGHT
											);
									}
								}
							} else {
								// Game is still in the same segment, waiting for other player to submit
								canDraw = false;
								isWaitingForOthers = true; // Current player submitted, waiting for others
								// If player already submitted, they should see the peek if it was their turn,
								// or the previous player's peek if it's the other player's turn.
								// For simplicity, after submission, just show waiting message.
								// If client needs their own peek for review, this logic would need to be more complex.
								if (gameRoom.currentSegmentIndex > 0) {
									const playerArtwork =
										gameRoom.artworks.find(
											(art) =>
												art.playerId === client.playerId
										);
									if (
										playerArtwork &&
										playerArtwork.segments[
											gameRoom.currentSegmentIndex - 1
										]
									) {
										const fullPreviousDrawing =
											playerArtwork.segments[
												gameRoom.currentSegmentIndex - 1
											];
										canvasData =
											await createCanvasWithBottomPeek(
												fullPreviousDrawing,
												CANVAS_WIDTH,
												CANVAS_HEIGHT,
												PEEK_HEIGHT
											);
									}
								}
							}

							const messageType = isGameOver
								? 'gameOver'
								: 'segmentUpdate';

							client.send(
								JSON.stringify({
									type: messageType,
									gameRoomId: gameRoom._id,
									message: getClientMessage(
										gameRoom,
										client.playerId
									),
									playerCount: gameRoom.playerCount,
									currentSegmentIndex:
										gameRoom.currentSegmentIndex,
									canDraw: canDraw,
									isWaitingForOthers: isWaitingForOthers,
									canvasData: canvasData,
									status: gameRoom.status,
									finalArtwork: finalArtwork,
									finalArtwork2: finalArtwork2, // Send second final artwork
								})
							);
							console.log(
								`[SUBMIT] Sent ${messageType} to client ${client.playerId}. canDraw: ${canDraw}, isWaiting: ${isWaitingForOthers}`
							);
						}
					});
				}
				break;

			default:
				console.warn(`Unknown message type: ${data.type}`);
				ws.send(
					JSON.stringify({
						type: 'error',
						message: 'Unknown message type.',
					})
				);
				break;
		}
	} catch (error) {
		console.error(`Error handling message type ${data.type}:`, error);
		ws.send(
			JSON.stringify({
				type: 'error',
				message: 'Server error processing message.',
			})
		);
	}
}

// --- WebSocket Close Handler ---
async function handleWebSocketClose(ws, wss, db) {
	const gameRoomsCollection = db.collection(COLLECTION_NAME);

	console.log(`Client disconnected. ID: ${ws.playerId}`);
	if (ws.gameRoomId) {
		try {
			let gameRoom = await gameRoomsCollection.findOne({
				_id: new ObjectId(ws.gameRoomId),
			});

			if (gameRoom) {
				// Remove disconnected player
				gameRoom.players = gameRoom.players.filter(
					(id) => id !== ws.playerId
				);
				gameRoom.playerObjects = gameRoom.playerObjects.filter(
					(p) => p.id !== ws.playerId
				);
				const newPlayerCount = gameRoom.players.length;
				gameRoom.playerCount = newPlayerCount;

				// Reset game status if players drop below minimum for 'playing'
				if (
					gameRoom.status === 'playing' &&
					newPlayerCount < MAX_PLAYERS
				) {
					gameRoom.status = 'waiting'; // Or 'aborted', depending on desired logic
					// Also reset game state if a player leaves in the middle
					gameRoom.currentSegmentIndex = 0;
					gameRoom.submittedPlayers = [];
					gameRoom.currentSegmentSubmissions = {};
					gameRoom.artworks = []; // Clear artworks
					gameRoom.finalArtworks = []; // Clear final artworks
					console.log(
						`[WS-CLOSE] Game ${gameRoom.gameCode} reset due to player leaving.`
					);
				} else if (newPlayerCount === 0) {
					// If no players left, delete the game room
					await gameRoomsCollection.deleteOne({ _id: gameRoom._id });
					console.log(
						`[WS-CLOSE] Game room ${gameRoom.gameCode} deleted as no players remain.`
					);
					return; // Exit as game room is deleted
				}

				await gameRoomsCollection.updateOne(
					{ _id: gameRoom._id },
					{
						$set: {
							players: gameRoom.players,
							playerObjects: gameRoom.playerObjects,
							playerCount: newPlayerCount,
							status: gameRoom.status,
							currentSegmentIndex: gameRoom.currentSegmentIndex, // Persist reset index
							submittedPlayers: gameRoom.submittedPlayers, // Persist reset
							currentSegmentSubmissions:
								gameRoom.currentSegmentSubmissions, // Persist reset
							artworks: gameRoom.artworks, // Persist cleared artworks
							finalArtworks: gameRoom.finalArtworks, // Persist cleared
						},
					}
				);

				// Re-fetch updated gameRoom after DB update to broadcast latest state
				gameRoom = await gameRoomsCollection.findOne({
					_id: new ObjectId(ws.gameRoomId),
				});

				// Notify remaining players
				if (gameRoom) {
					// Check if gameRoom still exists after update/deletion logic
					wss.clients.forEach(async (client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === gameRoom._id.toHexString()
						) {
							// Determine canDraw and isWaitingForOthers for the remaining player
							let canDraw = false;
							let isWaitingForOthers = false;
							let canvasData = null; // Clear canvas data for remaining player on disconnect

							if (gameRoom.status === 'playing') {
								// If game continues, determine if it's their turn
								const expectedDrawerId =
									gameRoom.playerObjects[
										gameRoom.currentSegmentIndex %
											MAX_PLAYERS
									].id;
								canDraw = client.playerId === expectedDrawerId;
								isWaitingForOthers =
									client.playerId !== expectedDrawerId;

								// If there's a peek for the current segment, retrieve it (from previous player's last drawing)
								if (gameRoom.currentSegmentIndex > 0) {
									const otherPlayerId =
										gameRoom.playerObjects.find(
											(p) => p.id !== client.playerId
										)?.id;
									const otherPlayerArtwork =
										gameRoom.artworks.find(
											(art) =>
												art.playerId === otherPlayerId
										);
									if (
										otherPlayerArtwork &&
										otherPlayerArtwork.segments[
											gameRoom.currentSegmentIndex - 1
										]
									) {
										const fullPreviousDrawing =
											otherPlayerArtwork.segments[
												gameRoom.currentSegmentIndex - 1
											];
										canvasData =
											await createCanvasWithBottomPeek(
												fullPreviousDrawing,
												CANVAS_WIDTH,
												CANVAS_HEIGHT,
												PEEK_HEIGHT
											);
									}
								}
							} else if (
								gameRoom.status === 'waiting' &&
								gameRoom.playerCount > 0
							) {
								// If game reverted to waiting and current client is still in room
								canDraw = false;
								isWaitingForOthers = false; // They are not waiting for anyone, but for a new player
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
									canvasData: canvasData, // Send peek for remaining player
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
		console.log('Disconnected client was not in a game room.');
	}
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
