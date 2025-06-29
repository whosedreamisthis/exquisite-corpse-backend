const { ObjectId } = require('mongodb');
const WebSocket = require('ws');
const { combineCanvases, createBlankCanvas } = require('./canvas-utils');

const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4;
const MAX_PLAYERS = 2;
const CANVAS_WIDTH = 1080; // Updated to 1080
const CANVAS_HEIGHT = 1920; // Updated to 1920

const RECONNECT_GRACE_PERIOD_MS = 15 * 1000; // 15 seconds grace period
const MAX_RECONNECT_ATTEMPTS = 5; // Max 5 reconnect attempts

const segments = ['Head', 'Torso', 'Legs', 'Feet'];

// Helper function to generate a unique 4-character alphanumeric game code
function generateUniqueGameCode() {
	return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function getClientMessage(gameRoom, playerId) {
	if (gameRoom.status === 'completed') {
		return '';
	}
	if (gameRoom.status === 'waiting') {
		return `Joined game ${gameRoom.gameCode}. Waiting for ${
			MAX_PLAYERS - gameRoom.playerCount
		} more player...`;
	}

	const hasSubmitted = gameRoom.submittedPlayers.includes(playerId);
	const segmentName = segments[gameRoom.currentSegmentIndex];

	return hasSubmitted
		? 'Waiting for other players to submit their segments.'
		: `Draw the ${segmentName}.`;
}

async function handleWebSocketMessage(ws, wss, db, message) {
	const data = JSON.parse(message);
	const gameRoomsCollection = db.collection(COLLECTION_NAME);

	// Handle 'createGame' message
	if (data.type === 'createGame') {
		let gameCode = generateUniqueGameCode();
		let existingGame = await gameRoomsCollection.findOne({
			gameCode: gameCode,
		});

		// Ensure the generated code is unique
		while (existingGame) {
			gameCode = generateUniqueGameCode();
			existingGame = await gameRoomsCollection.findOne({
				gameCode: gameCode,
			});
		}

		const initialBlankCanvas = await createBlankCanvas(
			CANVAS_WIDTH,
			CANVAS_HEIGHT
		);

		const newGameRoom = {
			gameCode: gameCode,
			players: [ws.id], // The creator is the first player
			playerObjects: [
				{
					id: ws.id,
					name: `Player-${Math.random().toString(36).substr(2, 4)}`,
					isDisconnected: false, // Track disconnection status
					reconnectAttempts: 0, // Track reconnect attempts
				},
			],
			playerCount: 1,
			status: 'waiting',
			currentSegmentIndex: 0,
			submittedPlayers: [],
			activeCanvasStates: [initialBlankCanvas, initialBlankCanvas],
			canvasAssignments: { [ws.id]: 0 },
			segmentHistory: {},
			finalArtworks: [],
			createdAt: new Date(),
		};

		const result = await gameRoomsCollection.insertOne(newGameRoom);
		ws.gameRoomId = result.insertedId.toString();
		ws.playerId = ws.id;

		console.log(
			`Game created with code: ${gameCode} by player: ${ws.playerId}`
		);

		ws.send(
			JSON.stringify({
				type: 'gameCreated',
				message: `Game created! Share code: ${gameCode}. Waiting for 1 more player...`,
				gameRoomId: ws.gameRoomId,
				gameCode: gameCode,
				playerCount: newGameRoom.playerCount,
				currentSegmentIndex: newGameRoom.currentSegmentIndex,
				currentSegment: segments[newGameRoom.currentSegmentIndex],
				canDraw: false,
				isWaitingForOthers: true,
				canvasData: initialBlankCanvas,
				previousRedLineY: null,
			})
		);
		return;
	}

	// New: Handle 'reconnectGame' message
	if (data.type === 'reconnectGame') {
		const gameRoom = await gameRoomsCollection.findOne({
			gameCode: data.gameCode,
		});

		if (!gameRoom) {
			ws.send(
				JSON.stringify({
					type: 'reconnectFailed',
					message: 'Game not found.',
				})
			);
			return;
		}

		// Find the player object in the game room
		const playerToReconnect = gameRoom.playerObjects.find(
			(p) => p.id === data.playerId
		);

		if (!playerToReconnect || !playerToReconnect.isDisconnected) {
			ws.send(
				JSON.stringify({
					type: 'reconnectFailed',
					message: 'Not a disconnected player or invalid ID.',
				})
			);
			return;
		}

		if (playerToReconnect.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			ws.send(
				JSON.stringify({
					type: 'reconnectFailed',
					message: 'Maximum reconnect attempts reached.',
				})
			);
			// Optionally, if MAX_RECONNECT_ATTEMPTS is reached, trigger the full disconnection logic here.
			// For now, we'll let the handleWebSocketClose timer do it.
			return;
		}

		// Re-associate the WebSocket with the existing player's session
		ws.gameRoomId = gameRoom._id.toString();
		ws.playerId = playerToReconnect.id;
		playerToReconnect.isDisconnected = false; // Player is now reconnected
		playerToReconnect.reconnectAttempts = 0; // Reset attempts on successful reconnect

		// Clear any pending disconnection timers for this player/room
		if (
			gameRoom.disconnectionTimers &&
			gameRoom.disconnectionTimers[ws.playerId]
		) {
			clearTimeout(gameRoom.disconnectionTimers[ws.playerId]);
			delete gameRoom.disconnectionTimers[ws.playerId];
		}

		await gameRoomsCollection.updateOne(
			{ _id: gameRoom._id },
			{ $set: gameRoom }
		);

		// Send updated game state to the reconnected player
		const assignedCanvasIndex = gameRoom.canvasAssignments[ws.playerId];
		const canvasDataToSend =
			gameRoom.activeCanvasStates[assignedCanvasIndex];

		let previousRedLineY = null;
		if (gameRoom.currentSegmentIndex > 0) {
			const otherPlayerCanvasIndex = assignedCanvasIndex === 0 ? 1 : 0;
			const previousSegmentSubmission = Object.values(
				gameRoom.segmentHistory[gameRoom.currentSegmentIndex - 1] || {}
			).find((sub) => sub.playerId !== ws.playerId);

			if (
				previousSegmentSubmission &&
				previousSegmentSubmission.redLineY !== undefined
			) {
				previousRedLineY = previousSegmentSubmission.redLineY;
			}
		}

		ws.send(
			JSON.stringify({
				type: 'reconnected',
				message: `Reconnected to game ${gameRoom.gameCode}!`,
				currentSegmentIndex: gameRoom.currentSegmentIndex,
				currentSegment: segments[gameRoom.currentSegmentIndex],
				playerCount: gameRoom.playerCount,
				status: gameRoom.status,
				canDraw: !gameRoom.submittedPlayers.includes(ws.playerId),
				isWaitingForOthers: gameRoom.submittedPlayers.includes(
					ws.playerId
				),
				canvasData: canvasDataToSend,
				previousRedLineY: previousRedLineY,
			})
		);

		// Notify other players that a player has reconnected
		wss.clients.forEach((client) => {
			if (
				client.readyState === WebSocket.OPEN &&
				client.gameRoomId === ws.gameRoomId &&
				client.playerId !== ws.playerId
			) {
				client.send(
					JSON.stringify({
						type: 'playerReconnected',
						message: `Player ${
							playerToReconnect.name || playerToReconnect.id
						} has reconnected!`,
						playerCount: gameRoom.playerCount, // Update player count for other clients
						status: gameRoom.status, // Update status for other clients
					})
				);
			}
		});
		console.log(
			`Player ${ws.playerId} reconnected to game ${gameRoom.gameCode}.`
		);
		return;
	}

	if (data.type === 'joinGame') {
		const gameRoom = await gameRoomsCollection.findOne({
			gameCode: data.gameCode,
		});
		if (!gameRoom || gameRoom.status === 'completed') return;

		// Check if the player is already in the room but was disconnected
		let playerExistsInRoom = gameRoom.playerObjects.find(
			(p) => p.id === ws.id
		);

		if (playerExistsInRoom && playerExistsInRoom.isDisconnected) {
			// If the player exists and was disconnected, treat this as a reconnect attempt
			// This case might be less common if the client explicitly sends 'reconnectGame'
			// but it's good to handle for robustness.
			ws.gameRoomId = gameRoom._id.toString();
			ws.playerId = ws.id;
			playerExistsInRoom.isDisconnected = false;
			playerExistsInRoom.reconnectAttempts = 0;

			if (
				gameRoom.disconnectionTimers &&
				gameRoom.disconnectionTimers[ws.playerId]
			) {
				clearTimeout(gameRoom.disconnectionTimers[ws.playerId]);
				delete gameRoom.disconnectionTimers[ws.playerId];
			}

			await gameRoomsCollection.updateOne(
				{ _id: gameRoom._id },
				{ $set: gameRoom }
			);

			// Send reconnected message
			const assignedCanvasIndex = gameRoom.canvasAssignments[ws.playerId];
			const canvasDataToSend =
				gameRoom.activeCanvasStates[assignedCanvasIndex];

			let previousRedLineY = null;
			if (gameRoom.currentSegmentIndex > 0) {
				const otherPlayerCanvasIndex =
					assignedCanvasIndex === 0 ? 1 : 0;
				const previousSegmentSubmission = Object.values(
					gameRoom.segmentHistory[gameRoom.currentSegmentIndex - 1] ||
						{}
				).find((sub) => sub.playerId !== ws.playerId);

				if (
					previousSegmentSubmission &&
					previousSegmentSubmission.redLineY !== undefined
				) {
					previousRedLineY = previousSegmentSubmission.redLineY;
				}
			}

			ws.send(
				JSON.stringify({
					type: 'reconnected', // Reconnected on join
					message: `Reconnected to game ${gameRoom.gameCode}!`,
					currentSegmentIndex: gameRoom.currentSegmentIndex,
					currentSegment: segments[gameRoom.currentSegmentIndex],
					playerCount: gameRoom.playerCount,
					status: gameRoom.status,
					canDraw: !gameRoom.submittedPlayers.includes(ws.playerId),
					isWaitingForOthers: gameRoom.submittedPlayers.includes(
						ws.playerId
					),
					canvasData: canvasDataToSend,
					previousRedLineY: previousRedLineY,
				})
			);

			wss.clients.forEach((client) => {
				if (
					client.readyState === WebSocket.OPEN &&
					client.gameRoomId === ws.gameRoomId &&
					client.playerId !== ws.playerId
				) {
					client.send(
						JSON.stringify({
							type: 'playerReconnected',
							message: `Player ${
								playerExistsInRoom.name || playerExistsInRoom.id
							} has reconnected!`,
							playerCount: gameRoom.playerCount,
							status: gameRoom.status,
						})
					);
				}
			});
			console.log(
				`Player ${ws.playerId} re-joined as a reconnected player to game ${gameRoom.gameCode}.`
			);
			return;
		}

		// Original join game logic for new players
		ws.gameRoomId = gameRoom._id.toString();
		ws.playerId = ws.id;

		if (!gameRoom.players.includes(ws.playerId)) {
			gameRoom.players.push(ws.playerId);
			gameRoom.playerObjects.push({
				id: ws.playerId,
				name: data.playerName,
				isDisconnected: false, // New player is not disconnected
				reconnectAttempts: 0,
			});
			gameRoom.playerCount = gameRoom.players.length;
		}

		if (
			gameRoom.playerCount === MAX_PLAYERS &&
			gameRoom.status === 'waiting'
		) {
			gameRoom.status = 'playing';
			gameRoom.canvasAssignments = {
				[gameRoom.players[0]]: 0,
				[gameRoom.players[1]]: 1,
			};
		}

		await gameRoomsCollection.updateOne(
			{ _id: gameRoom._id },
			{ $set: gameRoom }
		);

		wss.clients.forEach(async (client) => {
			if (
				client.readyState === WebSocket.OPEN &&
				client.gameRoomId === ws.gameRoomId
			) {
				const assignedCanvasIndex =
					gameRoom.canvasAssignments[client.playerId];
				const canvasDataToSend =
					gameRoom.activeCanvasStates[assignedCanvasIndex];

				let previousRedLineY = null;
				if (gameRoom.currentSegmentIndex > 0) {
					const otherPlayerCanvasIndex =
						assignedCanvasIndex === 0 ? 1 : 0;
					const previousSegmentSubmission = Object.values(
						gameRoom.segmentHistory[
							gameRoom.currentSegmentIndex - 1
						] || {}
					).find((sub) => sub.playerId !== client.playerId);

					if (
						previousSegmentSubmission &&
						previousSegmentSubmission.redLineY !== undefined
					) {
						previousRedLineY = previousSegmentSubmission.redLineY;
					}
				}

				client.send(
					JSON.stringify({
						type: 'gameJoined',
						message: getClientMessage(gameRoom, client.playerId),
						currentSegmentIndex: gameRoom.currentSegmentIndex,
						currentSegment: segments[gameRoom.currentSegmentIndex],
						playerCount: gameRoom.playerCount,
						status: gameRoom.status,
						canDraw: !gameRoom.submittedPlayers.includes(
							client.playerId
						),
						isWaitingForOthers: gameRoom.submittedPlayers.includes(
							client.playerId
						),
						canvasData: canvasDataToSend,
						previousRedLineY: previousRedLineY,
					})
				);
			}
		});
	}

	if (data.type === 'submitSegment') {
		const gameRoom = await gameRoomsCollection.findOne({
			_id: new ObjectId(ws.gameRoomId),
		});
		if (!gameRoom || gameRoom.status !== 'playing') return;

		if (!gameRoom.submittedPlayers.includes(ws.playerId)) {
			gameRoom.submittedPlayers.push(ws.playerId);
		}

		const canvasIndex = gameRoom.canvasAssignments[ws.playerId];
		gameRoom.activeCanvasStates[canvasIndex] = data.canvasData;

		if (!gameRoom.segmentHistory) {
			gameRoom.segmentHistory = {};
		}
		if (!gameRoom.segmentHistory[gameRoom.currentSegmentIndex]) {
			gameRoom.segmentHistory[gameRoom.currentSegmentIndex] = {};
		}

		gameRoom.segmentHistory[gameRoom.currentSegmentIndex][ws.playerId] = {
			playerId: ws.playerId,
			dataURL: data.canvasData,
			redLineY: data.redLineY,
		};

		const segmentIndex = gameRoom.currentSegmentIndex;
		console.log(
			`[SUBMIT] Player ${ws.playerId} submitted for segment ${segmentIndex}. Submitted players: ${gameRoom.submittedPlayers.length}`
		);

		if (gameRoom.submittedPlayers.length === MAX_PLAYERS) {
			console.log(
				`[SUBMIT] Both players submitted for segment ${segmentIndex}.`
			);

			const isFinalSegment = segmentIndex + 1 >= TOTAL_SEGMENTS;

			if (isFinalSegment) {
				gameRoom.status = 'completed';
				gameRoom.finalArtworks = [
					gameRoom.activeCanvasStates[0],
					gameRoom.activeCanvasStates[1],
				];
			} else {
				gameRoom.currentSegmentIndex++;
				gameRoom.submittedPlayers = [];
				gameRoom.currentSegmentSubmissions = {};

				Object.keys(gameRoom.canvasAssignments).forEach((playerId) => {
					gameRoom.canvasAssignments[playerId] =
						gameRoom.canvasAssignments[playerId] === 0 ? 1 : 0;
				});
			}

			await gameRoomsCollection.updateOne(
				{ _id: gameRoom._id },
				{ $set: gameRoom }
			);

			wss.clients.forEach((client) => {
				if (
					client.readyState === WebSocket.OPEN &&
					client.gameRoomId === ws.gameRoomId
				) {
					const assignedCanvasIndex =
						gameRoom.canvasAssignments[client.playerId];
					const canvasDataToSend =
						gameRoom.activeCanvasStates[assignedCanvasIndex];
					const isCompleted = gameRoom.status === 'completed';

					let previousRedLineYForNextPlayer = null;
					if (gameRoom.currentSegmentIndex > 0) {
						const prevSegmentIndex =
							gameRoom.currentSegmentIndex - 1;
						const otherPlayerIdInPrevRound = Object.keys(
							gameRoom.canvasAssignments
						).find(
							(pId) =>
								gameRoom.canvasAssignments[pId] !==
								assignedCanvasIndex
						);

						if (
							gameRoom.segmentHistory[prevSegmentIndex] &&
							gameRoom.segmentHistory[prevSegmentIndex][
								otherPlayerIdInPrevRound
							]
						) {
							previousRedLineYForNextPlayer =
								gameRoom.segmentHistory[prevSegmentIndex][
									otherPlayerIdInPrevRound
								].redLineY;
						}
					}

					client.send(
						JSON.stringify({
							type: 'gameUpdate',
							message: getClientMessage(
								gameRoom,
								client.playerId
							),
							currentSegmentIndex: gameRoom.currentSegmentIndex,
							currentSegment:
								segments[gameRoom.currentSegmentIndex],
							playerCount: gameRoom.playerCount,
							status: gameRoom.status,
							canDraw:
								!isCompleted &&
								!gameRoom.submittedPlayers.includes(
									client.playerId
								),
							isWaitingForOthers: isCompleted
								? false
								: gameRoom.submittedPlayers.includes(
										client.playerId
								  ),
							canvasData: isCompleted ? null : canvasDataToSend,
							finalArtwork1: gameRoom.finalArtworks?.[0],
							finalArtwork2: gameRoom.finalArtworks?.[1],
							previousRedLineY: previousRedLineYForNextPlayer,
						})
					);
				}
			});
		}

		await gameRoomsCollection.updateOne(
			{ _id: gameRoom._id },
			{ $set: gameRoom }
		);
	}

	if (data.type === 'playAgain') {
		const gameRoom = await gameRoomsCollection.findOne({
			_id: new ObjectId(data.gameRoomId),
		});

		if (!gameRoom) return;

		gameRoom.status = 'waiting';
		gameRoom.currentSegmentIndex = 0;
		gameRoom.submittedPlayers = [];
		gameRoom.activeCanvasStates = [
			await createBlankCanvas(CANVAS_WIDTH, CANVAS_HEIGHT),
			await createBlankCanvas(CANVAS_WIDTH, CANVAS_HEIGHT),
		];
		gameRoom.canvasAssignments = {};
		if (gameRoom.players.length > 0) {
			gameRoom.canvasAssignments[gameRoom.players[0]] = 0;
			if (gameRoom.players.length > 1) {
				gameRoom.canvasAssignments[gameRoom.players[1]] = 1;
			}
		}
		gameRoom.segmentHistory = {};
		gameRoom.finalArtworks = [];
		// Reset player disconnection states
		gameRoom.playerObjects.forEach((p) => {
			p.isDisconnected = false;
			p.reconnectAttempts = 0;
		});

		await gameRoomsCollection.updateOne(
			{ _id: gameRoom._id },
			{ $set: gameRoom }
		);

		wss.clients.forEach(async (client) => {
			if (
				client.readyState === WebSocket.OPEN &&
				client.gameRoomId === gameRoom._id.toString()
			) {
				const assignedCanvasIndex =
					gameRoom.canvasAssignments[client.playerId];
				const canvasDataToSend =
					assignedCanvasIndex !== undefined
						? gameRoom.activeCanvasStates[assignedCanvasIndex]
						: await createBlankCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);

				client.send(
					JSON.stringify({
						type: 'gameReset',
						message: getClientMessage(gameRoom, client.playerId),
						gameRoomId: gameRoom._id.toString(),
						gameCode: gameRoom.gameCode,
						playerCount: gameRoom.playerCount,
						currentSegmentIndex: gameRoom.currentSegmentIndex,
						currentSegment: segments[gameRoom.currentSegmentIndex],
						canDraw:
							gameRoom.playerCount === MAX_PLAYERS &&
							!gameRoom.submittedPlayers.includes(
								client.playerId
							),
						isWaitingForOthers:
							gameRoom.playerCount < MAX_PLAYERS ||
							gameRoom.submittedPlayers.includes(client.playerId),
						canvasData: canvasDataToSend,
						previousRedLineY: null,
						isGameOver: false,
						finalArtwork1: null,
						finalArtwork2: null,
					})
				);
			}
		});
		console.log(`Game room ${gameRoom.gameCode} reset for play again.`);
	}
}

async function handleWebSocketClose(ws, wss, db) {
	const gameRoomsCollection = db.collection(COLLECTION_NAME);
	if (ws.gameRoomId) {
		const gameRoom = await gameRoomsCollection.findOne({
			_id: new ObjectId(ws.gameRoomId),
		});
		if (gameRoom) {
			// Find the player object that disconnected
			const disconnectedPlayer = gameRoom.playerObjects.find(
				(p) => p.id === ws.playerId
			);

			// If the game is completed, apply the specific completed game disconnection logic
			if (gameRoom.status === 'completed') {
				if (disconnectedPlayer) {
					// Just mark as disconnected, don't remove immediately
					disconnectedPlayer.isDisconnected = true;
					// Increment reconnect attempts, even for completed games
					disconnectedPlayer.reconnectAttempts =
						(disconnectedPlayer.reconnectAttempts || 0) + 1;
				}

				// If all players are now disconnected from a completed game, delete the room
				const allPlayersDisconnected = gameRoom.playerObjects.every(
					(p) => p.isDisconnected
				);
				if (allPlayersDisconnected) {
					await gameRoomsCollection.deleteOne({
						_id: new ObjectId(ws.gameRoomId),
					});
					console.log(
						`Game room ${ws.gameRoomId} deleted as all players disconnected from a completed game.`
					);
				} else {
					// Update the game room to reflect the disconnected player's status
					await gameRoomsCollection.updateOne(
						{ _id: gameRoom._id },
						{ $set: { playerObjects: gameRoom.playerObjects } } // Only update playerObjects
					);
					console.log(
						`Player ${ws.playerId} disconnected from completed game room ${ws.gameRoomId}. Marked as disconnected.`
					);
				}
				return; // Exit after handling 'completed' game logic
			}

			// --- Logic for 'waiting' or 'playing' games ---
			if (disconnectedPlayer) {
				disconnectedPlayer.isDisconnected = true;
				disconnectedPlayer.reconnectAttempts =
					(disconnectedPlayer.reconnectAttempts || 0) + 1;
			}

			// Store the timer reference in the game room object
			if (!gameRoom.disconnectionTimers) {
				gameRoom.disconnectionTimers = {};
			}

			// Set a timeout to remove the player if they don't reconnect within the grace period
			gameRoom.disconnectionTimers[ws.playerId] = setTimeout(async () => {
				const updatedGameRoom = await gameRoomsCollection.findOne({
					_id: new ObjectId(ws.gameRoomId),
				});

				if (!updatedGameRoom) return; // Room might have been deleted by another player's disconnection

				const playerStillDisconnected =
					updatedGameRoom.playerObjects.find(
						(p) => p.id === ws.playerId && p.isDisconnected
					);

				if (
					playerStillDisconnected &&
					playerStillDisconnected.reconnectAttempts >=
						MAX_RECONNECT_ATTEMPTS
				) {
					console.log(
						`Player ${ws.playerId} failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts. Removing.`
					);

					// Remove the player from the game room
					updatedGameRoom.players = updatedGameRoom.players.filter(
						(pId) => pId !== ws.playerId
					);
					updatedGameRoom.playerObjects =
						updatedGameRoom.playerObjects.filter(
							(pObj) => pObj.id !== ws.playerId
						);
					updatedGameRoom.playerCount =
						updatedGameRoom.players.length;

					if (updatedGameRoom.playerCount === 0) {
						// If no players left, delete the game room
						await gameRoomsCollection.deleteOne({
							_id: new ObjectId(ws.gameRoomId),
						});
						console.log(
							`Game room ${ws.gameRoomId} deleted due to no players after extended disconnection.`
						);
					} else {
						// If one player remains, update status and notify
						updatedGameRoom.status = 'waiting';
						updatedGameRoom.submittedPlayers = [];
						updatedGameRoom.currentSegmentIndex = 0;
						updatedGameRoom.activeCanvasStates = [
							await createBlankCanvas(
								CANVAS_WIDTH,
								CANVAS_HEIGHT
							),
							await createBlankCanvas(
								CANVAS_WIDTH,
								CANVAS_HEIGHT
							),
						];
						updatedGameRoom.canvasAssignments = {};
						updatedGameRoom.segmentHistory = {};
						updatedGameRoom.finalArtworks = [];

						await gameRoomsCollection.updateOne(
							{ _id: updatedGameRoom._id },
							{ $set: updatedGameRoom }
						);

						wss.clients.forEach(async (client) => {
							if (
								client.readyState === WebSocket.OPEN &&
								client.gameRoomId === ws.gameRoomId
							) {
								client.send(
									JSON.stringify({
										type: 'playerPermanentlyDisconnected', // New message type
										message: `Player ${ws.playerId} permanently disconnected. Waiting for 1 more player...`,
										playerCount:
											updatedGameRoom.playerCount,
										status: updatedGameRoom.status,
										currentSegmentIndex: 0,
										canDraw: false,
										isWaitingForOthers: false,
										canvasData: await createBlankCanvas(
											CANVAS_WIDTH,
											CANVAS_HEIGHT
										),
										previousRedLineY: null,
									})
								);
							}
						});
						console.log(
							`Player ${ws.playerId} permanently disconnected from game room ${ws.gameRoomId}. Room is now waiting.`
						);
					}
				} else {
					// Player reconnected within the grace period or hadn't reached max attempts.
					// No action needed here, the 'reconnectGame' handler took care of it.
					console.log(
						`Player ${ws.playerId} disconnected but either reconnected or has remaining attempts.`
					);
				}
				delete gameRoom.disconnectionTimers[ws.playerId]; // Clean up the timer
			}, RECONNECT_GRACE_PERIOD_MS);

			await gameRoomsCollection.updateOne(
				{ _id: gameRoom._id },
				{
					$set: {
						playerObjects: gameRoom.playerObjects,
						disconnectionTimers: gameRoom.disconnectionTimers,
					},
				} // Update playerObjects and timers
			);

			// Notify other players about the temporary disconnection
			wss.clients.forEach((client) => {
				if (
					client.readyState === WebSocket.OPEN &&
					client.gameRoomId === ws.gameRoomId &&
					client.playerId !== ws.playerId
				) {
					client.send(
						JSON.stringify({
							type: 'playerTemporarilyDisconnected', // New message type
							message: `Player ${
								disconnectedPlayer.name || disconnectedPlayer.id
							} has temporarily disconnected. Waiting for them to reconnect... (Attempts left: ${
								MAX_RECONNECT_ATTEMPTS -
								disconnectedPlayer.reconnectAttempts
							})`,
							playerCount: gameRoom.playerCount,
							status: gameRoom.status,
						})
					);
				}
			});
			console.log(
				`Player ${ws.playerId} temporarily disconnected from game room ${ws.gameRoomId}.`
			);
		}
	}
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
