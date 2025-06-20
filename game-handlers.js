const { ObjectId } = require('mongodb');
const WebSocket = require('ws');
const {
	combineCanvases,
	createCanvasWithBottomPeek,
	createBlankCanvas,
} = require('./canvas-utils');

const COLLECTION_NAME = 'gameRooms';
const TOTAL_SEGMENTS = 4;
const MAX_PLAYERS = 2;
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const PEEK_HEIGHT = 100;

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

	if (hasSubmitted) {
		return 'Waiting for other players to submit their segments.';
	} else {
		return `Draw the ${segmentName}.`;
	}
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
				let peekData = null;

				if (canvasDataToSend && gameRoom.currentSegmentIndex > 0) {
					peekData = await createCanvasWithBottomPeek(
						canvasDataToSend,
						CANVAS_WIDTH,
						CANVAS_HEIGHT,
						PEEK_HEIGHT
					);
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
						peekData,
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
		gameRoom.currentSegmentSubmissions[ws.playerId] = data.canvasData;

		const segmentIndex = gameRoom.currentSegmentIndex;

		console.log(
			`[SUBMIT] Player ${ws.playerId} submitted for segment ${segmentIndex}. Submitted players: ${gameRoom.submittedPlayers.length}`
		);

		if (gameRoom.submittedPlayers.length === MAX_PLAYERS) {
			console.log(
				`[SUBMIT] Both players submitted for segment ${segmentIndex}.`
			);

			if (segmentIndex + 1 >= TOTAL_SEGMENTS) {
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

			// 🧠 THIS is the fix: broadcast the updated game state to all players
			wss.clients.forEach((client) => {
				if (
					client.readyState === WebSocket.OPEN &&
					client.gameRoomId === ws.gameRoomId
				) {
					const assignedCanvasIndex =
						gameRoom.canvasAssignments[client.playerId];
					const canvasDataToSend =
						gameRoom.activeCanvasStates[assignedCanvasIndex];

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
							canDraw: !gameRoom.submittedPlayers.includes(
								client.playerId
							),
							isWaitingForOthers:
								gameRoom.submittedPlayers.includes(
									client.playerId
								),
							canvasData: canvasDataToSend,
							finalArtwork1: gameRoom.finalArtworks?.[0],
							finalArtwork2: gameRoom.finalArtworks?.[1],
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
	// You already have this part correct—no changes needed here
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
