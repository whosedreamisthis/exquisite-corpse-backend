const { ObjectId } = require('mongodb');
const WebSocket = require('ws');
const { combineCanvases, createBlankCanvas } = require('./canvas-utils');

const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4;
const MAX_PLAYERS = 2;
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

const segments = ['Head', 'Torso', 'Legs', 'Feet'];

function getClientMessage(gameRoom, playerId) {
	if (gameRoom.status === 'completed') {
		return 'Game Over! The exquisite corpse is complete!';
	}
	if (gameRoom.status === 'waiting') {
		return `Joined game ${gameRoom.gameCode}. Waiting for ${
			MAX_PLAYERS - gameRoom.playerCount
		} more player(s)...`;
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

	if (data.type === 'joinGame') {
		const gameRoom = await gameRoomsCollection.findOne({
			gameCode: data.gameCode,
		});
		if (!gameRoom || gameRoom.status === 'completed') return;

		ws.gameRoomId = gameRoom._id.toString();
		ws.playerId = ws.id;

		if (!gameRoom.players.includes(ws.playerId)) {
			gameRoom.players.push(ws.playerId);
			gameRoom.playerObjects.push({
				id: ws.playerId,
				name: data.playerName,
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
						type: 'gameStateUpdate',
						message: getClientMessage(gameRoom, client.playerId),
						currentSegmentIndex: gameRoom.currentSegmentIndex,
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
				// Assign the two final artworks directly from activeCanvasStates
				gameRoom.finalArtworks = [
					gameRoom.activeCanvasStates[0], // This will be the first completed artwork
					gameRoom.activeCanvasStates[1], // This will be the second completed artwork
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
							type: 'gameStateUpdate',
							message: getClientMessage(
								gameRoom,
								client.playerId
							),
							currentSegmentIndex: gameRoom.currentSegmentIndex,
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
}

async function handleWebSocketClose(ws, wss, db) {
	const gameRoomsCollection = db.collection(COLLECTION_NAME);
	if (ws.gameRoomId) {
		const gameRoom = await gameRoomsCollection.findOne({
			_id: new ObjectId(ws.gameRoomId),
		});
		if (gameRoom) {
			// **BEGIN MODIFICATION**
			// Check if the game is already completed
			if (gameRoom.status === 'completed') {
				// If the game is completed, and a player disconnects,
				// we don't reset the game room unless both players have left.
				gameRoom.players = gameRoom.players.filter(
					(pId) => pId !== ws.playerId
				);
				gameRoom.playerObjects = gameRoom.playerObjects.filter(
					(pObj) => pObj.id !== ws.playerId
				);
				gameRoom.playerCount = gameRoom.players.length;

				if (gameRoom.playerCount === 0) {
					// If no players left, delete the game room
					await gameRoomsCollection.deleteOne({
						_id: new ObjectId(ws.gameRoomId),
					});
					console.log(
						`Game room ${ws.gameRoomId} deleted due to no players after game completion.`
					);
				} else {
					// One player remains, but game is complete. No need to reset game state.
					await gameRoomsCollection.updateOne(
						{ _id: gameRoom._id },
						{ $set: gameRoom }
					);
					console.log(
						`Player ${ws.playerId} disconnected from completed game room ${ws.gameRoomId}. Remaining player still sees results.`
					);
				}
				return; // Exit here, no further action needed for completed games
			}
			// **END MODIFICATION**

			// Original logic for active/waiting games (only executed if game is NOT completed)
			gameRoom.players = gameRoom.players.filter(
				(pId) => pId !== ws.playerId
			);
			gameRoom.playerObjects = gameRoom.playerObjects.filter(
				(pObj) => pObj.id !== ws.playerId
			);
			gameRoom.playerCount = gameRoom.players.length;

			if (gameRoom.playerCount === 0) {
				// If no players left, delete the game room
				await gameRoomsCollection.deleteOne({
					_id: new ObjectId(ws.gameRoomId),
				});
				console.log(
					`Game room ${ws.gameRoomId} deleted due to no players.`
				);
			} else {
				// If one player remains, update status and notify
				gameRoom.status = 'waiting';
				gameRoom.submittedPlayers = [];
				gameRoom.currentSegmentIndex = 0;
				gameRoom.activeCanvasStates = [
					await createBlankCanvas(CANVAS_WIDTH, CANVAS_HEIGHT),
					await createBlankCanvas(CANVAS_WIDTH, CANVAS_HEIGHT),
				];
				gameRoom.canvasAssignments = {};
				gameRoom.segmentHistory = {};
				gameRoom.finalArtworks = [];

				await gameRoomsCollection.updateOne(
					{ _id: gameRoom._id },
					{ $set: gameRoom }
				);

				wss.clients.forEach(async (client) => {
					if (
						client.readyState === WebSocket.OPEN &&
						client.gameRoomId === ws.gameRoomId
					) {
						client.send(
							JSON.stringify({
								type: 'playerDisconnected',
								message: `Player ${ws.playerId} disconnected. Waiting for 1 more player...`,
								playerCount: gameRoom.playerCount,
								status: gameRoom.status,
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
					`Player ${ws.playerId} disconnected from game room ${ws.gameRoomId}. Room is now waiting.`
				);
			}
		}
	}
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
