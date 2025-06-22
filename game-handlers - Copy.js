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

				// Get the redLineY from the *other* player's submitted segment
				// If it's the first segment (index 0), there's no previous line.
				// Otherwise, get the line from the canvas *not* assigned to this client in the previous round.
				let previousRedLineY = null;
				if (gameRoom.currentSegmentIndex > 0) {
					const otherPlayerCanvasIndex =
						assignedCanvasIndex === 0 ? 1 : 0;
					// Find the canvas data that was submitted by the other player for the previous round
					// This implies that activeCanvasStates stores objects with { dataURL, redLineY }
					// OR we need a separate field for previous red lines
					// For simplicity, let's assume the gameRoom.activeCanvasStates[otherPlayerCanvasIndex] now contains { dataURL, redLineY }
					// If it just stores dataURL, we need to modify the schema to store redLineY per submission.
					// For now, let's pass null and work on that schema if needed.
					// Let's assume for now that 'activeCanvasStates' is just the data URL, and we'll add
					// a new field 'redLineYs' to store the line data for each segment.
					// Reverting to the simpler approach for now, where redLineY is part of the submitted data object.

					// Check if there's previous submission data for the 'other' player that includes redLineY
					const previousSegmentSubmission = Object.values(
						gameRoom.segmentHistory[
							gameRoom.currentSegmentIndex - 1
						] || {}
					).find((sub) => sub.playerId !== client.playerId); // Find the other player's submission for the last round

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
						previousRedLineY: previousRedLineY, // Pass the previous player's red line Y
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
		// Store both canvasData and redLineY together for this segment submission
		gameRoom.activeCanvasStates[canvasIndex] = data.canvasData; // This will continue to store the full canvas image

		// We need a place to store the redLineY for each segment,
		// separate from the activeCanvasStates which store the full images.
		// Let's create a new structure in the gameRoom called 'segmentHistory'
		// This will store objects { playerId, dataURL, redLineY } for each segment.

		// Initialize segment history for the current segment if it doesn't exist
		if (!gameRoom.segmentHistory) {
			gameRoom.segmentHistory = {};
		}
		if (!gameRoom.segmentHistory[gameRoom.currentSegmentIndex]) {
			gameRoom.segmentHistory[gameRoom.currentSegmentIndex] = {};
		}

		// Store the current player's submission details including redLineY
		gameRoom.segmentHistory[gameRoom.currentSegmentIndex][ws.playerId] = {
			playerId: ws.playerId,
			dataURL: data.canvasData,
			redLineY: data.redLineY, // Store the red line Y for this submission
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
				// For final artwork, combine all segments from history, in order
				const allSegmentDataUrls = [];
				for (let i = 0; i < TOTAL_SEGMENTS; i++) {
					// Collect all dataURLs for segment 'i' (either player's, as they are combined)
					// If segmentHistory contains dataURL directly:
					// Example: allSegmentDataUrls.push(gameRoom.segmentHistory[i][gameRoom.players[0]].dataURL);
					// For 2 players, alternate combining
					allSegmentDataUrls.push(
						gameRoom.segmentHistory[i][
							gameRoom.players[i % MAX_PLAYERS]
						].dataURL
					);
				}
				gameRoom.finalArtworks = [
					await combineCanvases(allSegmentDataUrls),
				];
				// If you want to show TWO final artworks (one from each player's perspective if they only ever saw their chain)
				// this logic would be more complex, needing to reconstruct each player's chain.
				// For a single combined artwork, the above is fine. Let's stick to combining both player's inputs into ONE final image.
				// To get two unique images, we'd need to track which segments belonged to which 'chain' for each player.
				// Given the current 'activeCanvasStates' swap, it's a single collaborative chain.
				// So, finalArtworks[0] should be the combined one. The second might be a duplicate or removed.
				// Let's assume finalArtworks is an array of combined canvases for now.
				// If the user wants two *different* combined artworks based on different starting players,
				// we'd need to generate and store them.
				// For now, let's make finalArtworks[1] null if only one combined artwork is desired.
				gameRoom.finalArtworks = [
+					gameRoom.activeCanvasStates[0],
+					gameRoom.activeCanvasStates[1],
+				]; // Or generate a second one if game logic supports it.
			} else {
				gameRoom.currentSegmentIndex++;
				gameRoom.submittedPlayers = [];
				gameRoom.currentSegmentSubmissions = {}; // Clear this as well

				// Swap canvas assignments for the next round
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
						// If it's not the very first segment of the game
						// Find the submission for the *current* segment from the *other* player in the previous round
						const prevSegmentIndex =
							gameRoom.currentSegmentIndex - 1;
						const otherPlayerIdInPrevRound = Object.keys(
							gameRoom.canvasAssignments
						).find(
							(pId) =>
								gameRoom.canvasAssignments[pId] !==
								assignedCanvasIndex
						); // Find the player who was assigned the *other* canvas in the *current* round (meaning they submitted to the one this client is now drawing from in previous round)

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
							previousRedLineY: previousRedLineYForNextPlayer, // Pass the other player's chosen red line Y
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
            // Check if the game is already completed
            if (gameRoom.status === 'completed') {
                // If the game is completed, and a player disconnects,
                // we don't reset the game room unless both players have left.
                gameRoom.players = gameRoom.players.filter((pId) => pId !== ws.playerId);
                gameRoom.playerObjects = gameRoom.playerObjects.filter((pObj) => pObj.id !== ws.playerId);
                gameRoom.playerCount = gameRoom.players.length;

                if (gameRoom.playerCount === 0) {
                    await gameRoomsCollection.deleteOne({ _id: new ObjectId(ws.gameRoomId) });
                    console.log(`Game room ${ws.gameRoomId} deleted due to no players after game completion.`);
                } else {
                    // One player remains, but game is complete. No need to reset game state.
                    await gameRoomsCollection.updateOne({ _id: gameRoom._id }, { $set: gameRoom });
                    console.log(`Player ${ws.playerId} disconnected from completed game room ${ws.gameRoomId}. Remaining player still sees results.`);
                }
                return; // Exit here, no further action needed for completed games
            }

            // Original logic for active/waiting games
            gameRoom.players = gameRoom.players.filter((pId) => pId !== ws.playerId);
            gameRoom.playerObjects = gameRoom.playerObjects.filter((pObj) => pObj.id !== ws.playerId);
            gameRoom.playerCount = gameRoom.players.length;

            if (gameRoom.playerCount === 0) {
                await gameRoomsCollection.deleteOne({ _id: new ObjectId(ws.gameRoomId) });
                console.log(`Game room ${ws.gameRoomId} deleted due to no players.`);
            } else {
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

                await gameRoomsCollection.updateOne({ _id: gameRoom._id }, { $set: gameRoom });

                wss.clients.forEach(async (client) => {
                    if (client.readyState === WebSocket.OPEN && client.gameRoomId === ws.gameRoomId) {
                        client.send(
                            JSON.stringify({
                                type: 'playerDisconnected',
                                message: `Player ${ws.playerId} disconnected. Waiting for 1 more player...`,
                                playerCount: gameRoom.playerCount,
                                status: gameRoom.status,
                                currentSegmentIndex: 0,
                                canDraw: false,
                                isWaitingForOthers: false,
                                canvasData: await createBlankCanvas(CANVAS_WIDTH, CANVAS_HEIGHT),
                                previousRedLineY: null,
                            })
                        );
                    }
                });
                console.log(`Player ${ws.playerId} disconnected from game room ${ws.gameRoomId}. Room is now waiting.`);
            }
        }
    }
}

module.exports = {
	handleWebSocketMessage,
	handleWebSocketClose,
};
