// game-handlers.js

const { ObjectId } = require('mongodb');
const WebSocket = require('ws');
const { combineCanvases, overlayCanvases } = require('./canvas-utils');

// --- Constants ---
const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4;
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

// Segments for the game (Head, Torso, Legs, Feet)
const segments = ['Head', 'Torso', 'Legs', 'Feet'];

// --- WebSocket Message Handler Functions ---

async function handleWebSocketMessage(ws, wss, db, message) {
	try {
		const parsedMessage = JSON.parse(message.toString());
		console.log('Received from client:', parsedMessage.type);

		const {
			type,
			gameRoomId,
			gameCode,
			canvasData,
			segmentIndex,
			nickname,
		} = parsedMessage;

		let gameRoom;
		if (gameRoomId) {
			try {
				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(gameRoomId) });
			} catch (err) {
				console.warn(
					`Invalid gameRoomId provided: ${gameRoomId}. Trying with gameCode.`
				);
				gameRoom = null;
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
					);
					if (!existingPlayer) {
						if (gameRoom.players.length < 2) {
							gameRoom.players.push(ws.playerId);
							isNewPlayer = true;
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
							return;
						}
					} else {
						const playerObj = gameRoom.playerObjects.find(
							(p) => p.id === ws.playerId
						);
						if (playerObj && !playerObj.nickname && nickname) {
							playerObj.nickname = nickname;
							await db.collection(COLLECTION_NAME).updateOne(
								{ _id: new ObjectId(ws.gameRoomId) },
								{
									$set: {
										playerObjects: gameRoom.playerObjects,
									},
								}
							);
						}
					}
				} else {
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
						players: [ws.playerId],
						playerObjects: [newPlayerObj],
						playerCount: 1,
						currentTurn: 0,
						canvasSegments: [],
						currentSegmentIndex: 0,
						submittedPlayers: [],
						lastActivity: new Date(),
						status: 'waiting',
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
					await db.collection(COLLECTION_NAME).updateOne(
						{ _id: new ObjectId(ws.gameRoomId) },
						{
							$set: {
								players: gameRoom.players,
								playerObjects: gameRoom.playerObjects,
								playerCount: gameRoom.players.length,
								lastActivity: new Date(),
							},
						}
					);
				}

				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(ws.gameRoomId) });

				let initialCanvasData = null;
				if (gameRoom.currentSegmentIndex > 0) {
					// Bypass combineCanvases for initial state
					console.log(
						'BYPASS: Skipping combineCanvases for initial canvas data.'
					);
					initialCanvasData =
						'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // Placeholder 1x1 transparent PNG
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
							if (gameRoom.currentSegmentIndex === 0) {
								messageForClient = `Game ${gameCode} is ready! Draw the ${segments[0]}.`;
								clientCanDraw = true;
								clientIsWaitingForOthers = false;
							} else {
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
										: 'playerJoined',
								playerCount: gameRoom.playerCount,
								message: messageForClient,
								gameRoomId: gameRoom._id.toString(),
								currentSegmentIndex:
									gameRoom.currentSegmentIndex,
								canDraw: clientCanDraw,
								isWaitingForOthers: clientIsWaitingForOthers,
								canvasData: initialCanvasData,
							})
						);
					}
				});

				if (
					gameRoom.playerCount === 2 &&
					gameRoom.status === 'waiting'
				) {
					await db.collection(COLLECTION_NAME).updateOne(
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

				gameRoom = await db
					.collection(COLLECTION_NAME)
					.findOne({ _id: new ObjectId(ws.gameRoomId) });

				ws.send(
					JSON.stringify({
						type: 'submissionReceived',
						message:
							'Your segment submitted. Waiting for other players.',
						canDraw: false,
						isWaitingForOthers: true,
					})
				);

				if (gameRoom.submittedPlayers.length === gameRoom.playerCount) {
					console.log(
						`SERVER: All players submitted for segment ${segmentIndex}. Calling advanceSegment.`
					); // ADDED LOG
					await advanceSegment(gameRoom._id, wss, db);
				} else {
					console.log(
						`SERVER: Waiting for ${
							gameRoom.playerCount -
							gameRoom.submittedPlayers.length
						} more players to submit.`
					); // ADDED LOG
					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === ws.gameRoomId &&
							client.playerId !== ws.playerId
						) {
							client.send(
								JSON.stringify({
									type: 'playerSubmitted',
									message:
										'Another player submitted their segment.',
									submittedCount:
										updatedSubmittedPlayers.length,
									totalPlayers: gameRoom.playerCount,
									canDraw: true,
									isWaitingForOthers: false,
								})
							);
						}
					});
				}
				break;

			case 'requestInitialState':
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
						// BYPASS: Skipping combineCanvases for requestInitialState
						console.log(
							'BYPASS: Skipping combineCanvases for requestInitialState.'
						);
						currentCanvasData =
							'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // Placeholder 1x1 transparent PNG
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
						currentCanvasData = gameRoom.finalArtwork; // This might still try to load the final artwork if it was combined before
					} else {
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
							type: 'playerJoined',
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
					const updatedCanvasSegments =
						gameRoom.canvasSegments.filter(
							(seg) =>
								seg.segmentIndex !==
								gameRoom.currentSegmentIndex
						);
					await db.collection(COLLECTION_NAME).updateOne(
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
									canvasData: null,
									canDraw: true,
									isWaitingForOthers: false,
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

async function advanceSegment(gameRoomObjectId, wss, db) {
	console.log(
		`SERVER: Entering advanceSegment function for game room ObjectId: ${gameRoomObjectId}`
	);
	console.log(`SERVER: Type of gameRoomObjectId: ${typeof gameRoomObjectId}`);
	console.log(
		`SERVER: Is gameRoomObjectId an ObjectId instance? ${
			gameRoomObjectId instanceof ObjectId
		}`
	);

	try {
		console.log(
			`SERVER: advanceSegment called for game room ${gameRoomObjectId}.`
		);

		let gameRoom = await db
			.collection(COLLECTION_NAME)
			.findOne({ _id: gameRoomObjectId });

		if (!gameRoom) {
			console.error(
				`SERVER ERROR: Game room ${gameRoomObjectId} not found for segment advancement.`
			);
			return;
		}
		console.log(
			`SERVER: Game room fetched successfully. Current segmentIndex: ${gameRoom.currentSegmentIndex}`
		);

		const completedSegmentDrawings = gameRoom.canvasSegments
			.filter(
				(seg) =>
					seg.segmentIndex === gameRoom.currentSegmentIndex &&
					!seg.isCombined
			)
			.map((seg) => seg.dataUrl);

		console.log(
			`SERVER: Found ${completedSegmentDrawings.length} drawings for current segment (${gameRoom.currentSegmentIndex}).`
		);
		console.log(
			`SERVER: First drawing dataUrl length: ${
				completedSegmentDrawings[0]
					? completedSegmentDrawings[0].length
					: 'N/A'
			}`
		);
		console.log(
			`SERVER: Second drawing dataUrl length: ${
				completedSegmentDrawings[1]
					? completedSegmentDrawings[1].length
					: 'N/A'
			}`
		);
		if (
			completedSegmentDrawings[0] &&
			completedSegmentDrawings[0].length < 100
		) {
			console.log(
				`SERVER: First drawing dataUrl snippet: ${completedSegmentDrawings[0].substring(
					0,
					50
				)}...`
			);
		}
		if (
			completedSegmentDrawings[1] &&
			completedSegmentDrawings[1].length < 100
		) {
			console.log(
				`SERVER: Second drawing dataUrl snippet: ${completedSegmentDrawings[1].substring(
					0,
					50
				)}...`
			);
		}

		let combinedCanvasForNextSegment = null;
		try {
			if (completedSegmentDrawings.length > 0) {
				// BYPASS: Skipping overlayCanvases for segment combination.
				console.log(
					`BYPASS: Skipping overlayCanvases for current segment. Setting placeholder.`
				);
				combinedCanvasForNextSegment =
					'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // Placeholder 1x1 transparent PNG

				const combinedSegmentEntry = {
					segmentIndex: gameRoom.currentSegmentIndex,
					dataUrl: combinedCanvasForNextSegment,
					isCombined: true,
					createdAt: new Date(),
				};

				const updatedCanvasSegments = Array.isArray(
					gameRoom.canvasSegments
				)
					? [...gameRoom.canvasSegments, combinedSegmentEntry]
					: [combinedSegmentEntry];

				console.log(
					`SERVER: Updating game room with combined segment entry (bypassed image processing).`
				);
				await db.collection(COLLECTION_NAME).updateOne(
					{ _id: gameRoomObjectId },
					{
						$set: {
							canvasSegments: updatedCanvasSegments,
						},
					}
				);
				console.log(
					`SERVER: Game room updated with combined segment entry.`
				);
			} else {
				console.warn(
					`SERVER WARNING: No completed drawings found for current segment ${gameRoom.currentSegmentIndex}. Cannot combine.`
				);
			}
		} catch (error) {
			console.error(
				'SERVER ERROR: Error during canvas combination or DB update of combined entry in advanceSegment (BYPASS ACTIVE):',
				error
			);
			return;
		}

		const nextSegmentIndex = gameRoom.currentSegmentIndex + 1;
		let finalArtwork = null;

		if (nextSegmentIndex < TOTAL_SEGMENTS) {
			console.log(
				`SERVER: Advancing to next segment: ${nextSegmentIndex}.`
			);
			await db.collection(COLLECTION_NAME).updateOne(
				{ _id: gameRoomObjectId },
				{
					$set: {
						currentSegmentIndex: nextSegmentIndex,
						submittedPlayers: [],
						lastActivity: new Date(),
						status: 'in-progress',
					},
				}
			);
			console.log(
				`SERVER: Game ${gameRoom.gameCode} advanced to segment ${nextSegmentIndex} in DB.`
			);

			// Re-fetch gameRoom to get the latest canvasSegments for background
			gameRoom = await db
				.collection(COLLECTION_NAME)
				.findOne({ _id: gameRoomObjectId });

			let combinedPreviousSegments = null;
			if (gameRoom.currentSegmentIndex > 0) {
				// BYPASS: Skipping combineCanvases for next background
				console.log(
					`BYPASS: Skipping combineCanvases for next background. Setting placeholder.`
				);
				combinedPreviousSegments =
					'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // Placeholder 1x1 transparent PNG
			}

			wss.clients.forEach((client) => {
				if (
					client.readyState === WebSocket.OPEN &&
					client.gameRoomId === gameRoomObjectId.toString()
				) {
					const messageToSend = JSON.stringify({
						type: 'segmentAdvanced',
						currentSegmentIndex: nextSegmentIndex,
						message: `Draw the ${segments[nextSegmentIndex]}.`,
						canvasData: combinedPreviousSegments, // This will be the placeholder
						canDraw: true,
						isWaitingForOthers: false,
					});
					console.log(
						`SERVER: Sending segmentAdvanced to client ${
							client.playerId
						} (in game ${gameRoomObjectId}). Message: ${messageToSend.substring(
							0,
							200
						)}...`
					);
					client.send(messageToSend);
				} else {
					console.log(
						`SERVER: Skipping client ${client.playerId} for segmentAdvanced broadcast. ReadyState: ${client.readyState}, GameRoomId: ${client.gameRoomId}`
					);
				}
			});
			console.log(
				`SERVER: Finished broadcasting segment advanced message.`
			);
		} else {
			console.log(
				`SERVER: Game ${gameRoom.gameCode} is complete! Initiating game over.`
			);

			// BYPASS: Skipping combineCanvases for final artwork
			console.log(
				`BYPASS: Skipping combineCanvases for final artwork. Setting placeholder.`
			);
			finalArtwork =
				'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // Placeholder 1x1 transparent PNG

			await db.collection(COLLECTION_NAME).updateOne(
				{ _id: gameRoomObjectId },
				{
					$set: {
						status: 'completed',
						finalArtwork: finalArtwork,
						lastActivity: new Date(),
						canvasSegments: gameRoom.canvasSegments,
					},
				}
			);
			console.log('SERVER: Game status set to completed in DB.');

			wss.clients.forEach((client) => {
				if (
					client.readyState === WebSocket.OPEN &&
					client.gameRoomId === gameRoomObjectId.toString()
				) {
					const messageToSend = JSON.stringify({
						type: 'gameOver',
						message:
							'The Exquisite Corpse is complete! View the final artwork.',
						finalArtwork: finalArtwork, // This will be the placeholder
						currentSegmentIndex: TOTAL_SEGMENTS,
						canDraw: false,
						isWaitingForOthers: false,
					});
					console.log(
						`SERVER: Sending gameOver to client ${
							client.playerId
						}. Message: ${messageToSend.substring(0, 200)}...`
					);
					client.send(messageToSend);
				}
			});
			console.log(`SERVER: Finished broadcasting game over message.`);
		}
	} catch (error) {
		console.error('SERVER FATAL ERROR in advanceSegment:', error);
	}
}

async function handleWebSocketClose(ws, wss, db, error) {
	if (error) {
		console.error(
			`WebSocket closed due to error for client ${ws.id}:`,
			error
		);
	} else {
		console.log(`Client ${ws.id} disconnected.`);
	}

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
					(p) => p.id !== ws.playerId
				);
				const newPlayerCount = updatedPlayers.length;

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
									canDraw: false,
									isWaitingForOthers: false,
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
			console.error(
				`Error handling WebSocket close for client ${ws.id}:`,
				err
			);
		}
	}
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
