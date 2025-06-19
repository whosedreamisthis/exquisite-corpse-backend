// gameHandlers.js
const { ObjectId } = require('mongodb');
const WebSocket = require('ws'); // <-- Make sure to import WebSocket here

const COLLECTION_NAME = 'gameRooms'; // Same collection name as before
const TOTAL_SEGMENTS = 4; // Same constant as before

// This function will be called on each 'message' event from a WebSocket client
// It receives the WebSocket instance (ws), the full WebSocket Server (wss), and the db instance
const handleWebSocketMessage = async (ws, wss, db, message) => {
	try {
		const data = JSON.parse(message.toString());
		console.log('Received from client:', data);

		if (data.type === 'joinGame') {
			let gameRoom = await db
				.collection(COLLECTION_NAME)
				.findOne({ gameCode: data.gameCode });

			let isNewPlayer = false;

			if (gameRoom) {
				console.log(
					`Client ${ws.id} joining existing game room: ${data.gameCode}`
				);
				ws.gameRoomId = gameRoom._id.toString();

				if (!gameRoom.players.includes(ws.playerId)) {
					if (gameRoom.players.length < 2) {
						gameRoom.players.push(ws.playerId);
						isNewPlayer = true;
					} else {
						ws.send(
							JSON.stringify({
								type: 'error',
								message: 'Game room is full.',
							})
						);
						return;
					}
				}
				gameRoom.playerCount = gameRoom.players.length;

				if (isNewPlayer) {
					await db.collection(COLLECTION_NAME).updateOne(
						{ _id: gameRoom._id },
						{
							$set: {
								players: gameRoom.players,
								playerCount: gameRoom.playerCount,
							},
						}
					);
				}

				ws.send(
					JSON.stringify({
						type: 'initialState',
						gameCode: gameRoom.gameCode,
						playerCount: gameRoom.playerCount,
						currentSegmentIndex: gameRoom.currentSegmentIndex,
						canvasData:
							gameRoom.canvasSegments[
								gameRoom.currentSegmentIndex > 0
									? gameRoom.currentSegmentIndex - 1
									: 0
							] || null,
						message: `Joined game ${data.gameCode}.`,
					})
				);

				if (gameRoom.playerCount === 2) {
					if (
						gameRoom.currentTurn === undefined ||
						gameRoom.currentTurn === null
					) {
						gameRoom.currentTurn = 0;
						await db
							.collection(COLLECTION_NAME)
							.updateOne(
								{ _id: gameRoom._id },
								{ $set: { currentTurn: gameRoom.currentTurn } }
							);
					}

					wss.clients.forEach((client) => {
						if (
							client.readyState === WebSocket.OPEN &&
							client.gameRoomId === ws.gameRoomId
						) {
							client.send(
								JSON.stringify({
									type: 'playerJoined',
									gameCode: gameRoom.gameCode,
									playerCount: gameRoom.playerCount,
									currentSegmentIndex:
										gameRoom.currentSegmentIndex,
									isMyTurnToDraw:
										client.playerId ===
										gameRoom.players[gameRoom.currentTurn],
									message: `Game ${gameRoom.gameCode} started!`,
								})
							);
						}
					});
				}
			} else {
				console.log(
					`Client ${ws.id} creating new game room: ${data.gameCode}`
				);
				const newGameRoom = {
					gameCode: data.gameCode,
					players: [ws.playerId],
					playerCount: 1,
					currentTurn: 0,
					canvasSegments: [],
					currentSegmentIndex: 0,
					createdAt: new Date(),
				};

				const result = await db
					.collection(COLLECTION_NAME)
					.insertOne(newGameRoom);
				gameRoom = { _id: result.insertedId, ...newGameRoom };

				ws.gameRoomId = gameRoom._id.toString();

				ws.send(
					JSON.stringify({
						type: 'initialState',
						gameCode: gameRoom.gameCode,
						playerCount: gameRoom.playerCount,
						currentSegmentIndex: gameRoom.currentSegmentIndex,
						canvasData: null,
						isMyTurnToDraw: true,
						message: `Game ${data.gameCode} created! Waiting for another player...`,
					})
				);
			}
		} else if (
			data.type === 'submitSegment' &&
			data.gameRoomId && // This 'gameRoomId' from the client is actually the gameCode (e.g., 'Q1')
			data.canvasData
		) {
			// **FIX 1: Find the game room using the gameCode (which is in data.gameRoomId)**
			const gameRoom = await db
				.collection('gameRooms')
				.findOne({ gameCode: data.gameRoomId });

			if (!gameRoom) {
				console.error(
					'SubmitSegment: Game room not found for code:',
					data.gameRoomId
				);
				ws.send(
					JSON.stringify({
						type: 'error',
						message: 'Game room not found.',
					})
				);
				return;
			}

			// Get the actual MongoDB ObjectId from the found document
			const gameObjectId = gameRoom._id;

			const currentPlayerIndex = gameRoom.players.indexOf(ws.playerId);
			if (
				currentPlayerIndex === -1 ||
				gameRoom.currentTurn !== currentPlayerIndex
			) {
				ws.send(
					JSON.stringify({
						type: 'error',
						message: "It's not your turn to submit.",
					})
				);
				return;
			}

			gameRoom.canvasSegments[data.segmentIndex] = data.canvasData;

			let newCurrentSegmentIndex = gameRoom.currentSegmentIndex;
			let newCurrentTurn =
				(gameRoom.currentTurn + 1) % gameRoom.players.length;
			let messageToOtherPlayerType = 'canvasSwap';
			let messageToOtherPlayerCanvasData = data.canvasData;

			if (data.segmentIndex === TOTAL_SEGMENTS - 1) {
				messageToOtherPlayerType = 'finalDrawing';
				messageToOtherPlayerCanvasData = data.canvasData;
				newCurrentSegmentIndex = TOTAL_SEGMENTS - 1;
			} else {
				newCurrentSegmentIndex = gameRoom.currentSegmentIndex + 1;
			}

			await db.collection(COLLECTION_NAME).updateOne(
				{ _id: gameObjectId }, // **FIX 2: Use the actual ObjectId for the update query**
				{
					$set: {
						canvasSegments: gameRoom.canvasSegments,
						currentTurn: newCurrentTurn,
						currentSegmentIndex: newCurrentSegmentIndex,
						lastUpdated: new Date(),
					},
				}
			);

			wss.clients.forEach((client) => {
				if (
					client.readyState === WebSocket.OPEN &&
					client.gameRoomId === gameObjectId.toString() // **FIX 3: Correctly compare client's stored _id with the actual gameRoom's _id**
				) {
					if (client.playerId === ws.playerId) {
						client.send(
							JSON.stringify({
								type: 'waitingForOtherPlayerSubmit',
								message: `You submitted your drawing! Waiting for other player's turn...`,
							})
						);
					} else {
						client.send(
							JSON.stringify({
								type: messageToOtherPlayerType,
								gameRoomId: gameRoom._id.toString(), // Send the actual _id back to the client for future reference
								currentSegmentIndex: newCurrentSegmentIndex,
								canvasData: messageToOtherPlayerCanvasData,
								isMyTurnToDraw: true,
								message:
									messageToOtherPlayerType === 'finalDrawing'
										? 'Game Over! Here is the final exquisite corpse.'
										: `Canvas swapped! Draw your next segment!`,
							})
						);
					}
				}
			});
		} else if (
			data.type === 'drawUpdate' &&
			data.gameRoomId &&
			data.canvasData
		) {
			console.log(
				"Ignoring 'drawUpdate' for now, focusing on 'submitSegment'."
			);
		}
	} catch (error) {
		console.error('Error processing client message:', error);
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(
				JSON.stringify({
					type: 'error',
					message: 'Invalid message format or server error.',
				})
			);
		}
	}
};

// This function will be called on each 'close' event from a WebSocket client
const handleWebSocketClose = async (ws, db, wss) => {
	console.log(`Client ${ws.id} disconnected from WebSocket`);
	if (ws.gameRoomId && ws.playerId) {
		try {
			const gameId = new ObjectId(ws.gameRoomId); // This is likely okay as ws.gameRoomId is already the ObjectId
			const gameRoom = await db
				.collection(COLLECTION_NAME)
				.findOne({ _id: gameId });
			if (gameRoom) {
				const updatedPlayers = gameRoom.players.filter(
					(playerId) => playerId !== ws.playerId
				);

				let newPlayerCount = updatedPlayers.length;
				if (newPlayerCount === 0) {
					await db
						.collection(COLLECTION_NAME)
						.deleteOne({ _id: gameId });
					console.log(
						`Game room ${ws.gameRoomId} deleted as all players disconnected.`
					);
				} else {
					await db.collection(COLLECTION_NAME).updateOne(
						{ _id: gameId },
						{
							$set: {
								players: updatedPlayers,
								playerCount: newPlayerCount,
								currentTurn: 0, // Simplistic: reset to first player
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
									isMyTurnToDraw: false,
								})
							);
						}
					});
				}
			}
		} catch (error) {
			console.error('Error handling client disconnect cleanup:', error);
		}
	}
};

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
