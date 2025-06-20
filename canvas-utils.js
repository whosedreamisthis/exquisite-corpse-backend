// canvas-utils.js

// IMPORTANT: Ensure 'canvas' npm package is installed: npm install canvas
const { createCanvas, Image } = require('canvas');

/**
 * Combines an array of base64 image data URLs (canvas segments) into a single base64 image.
 * Each segment is assumed to be the same width and will be stacked vertically.
 * @param {string[]} segmentDataUrls An array of base64 data URLs for each canvas segment.
 * @returns {Promise<string>} A promise that resolves with the base64 data URL of the combined canvas.
 */
async function combineCanvases(segmentDataUrls) {
	if (!segmentDataUrls || segmentDataUrls.length === 0) {
		console.warn('combineCanvases received no segments to combine.');
		return ''; // Return an empty string if no segments
	}

	// Load all images first to determine total dimensions
	const images = [];
	let totalHeight = 0;
	let maxWidth = 0; // Assuming all segments have the same width, but we'll find the max just in case

	for (const dataUrl of segmentDataUrls) {
		if (!dataUrl) {
			console.warn(
				'Skipping null or empty segmentDataUrl in combineCanvases.'
			);
			continue;
		}
		const img = new Image();
		img.src = dataUrl;
		images.push(img);

		// We need to wait for each image to load to get its dimensions
		await new Promise((resolve) => {
			img.onload = () => {
				totalHeight += img.height;
				if (img.width > maxWidth) {
					maxWidth = img.width;
				}
				resolve();
			};
			img.onerror = (err) => {
				console.error(
					'Failed to load image in combineCanvases:',
					err,
					dataUrl.substring(0, 50) + '...'
				);
				// Resolve even on error to prevent blocking, but data might be incomplete
				resolve();
			};
		});
	}

	if (images.length === 0) {
		console.warn('No valid images to combine.');
		return '';
	}

	// Create a new canvas to draw all combined segments
	const canvas = createCanvas(maxWidth, totalHeight);
	const ctx = canvas.getContext('2d');

	// Draw each image onto the new canvas, stacking them vertically
	let currentY = 0;
	for (const img of images) {
		if (img.width && img.height) {
			// Check if image loaded successfully
			ctx.drawImage(img, 0, currentY, maxWidth, img.height);
			currentY += img.height;
		}
	}

	return canvas.toDataURL();
}

/**
 * Overlays an array of base64 image data URLs onto a single canvas.
 * Images are scaled to fit the target dimensions and drawn on top of each other.
 * @param {string[]} segmentDataUrls An array of base64 data URLs for the images to overlay.
 * @param {number} targetWidth The desired width of the resulting canvas.
 * @param {number} targetHeight The desired height of the resulting canvas.
 * @returns {Promise<string>} A promise that resolves with the base64 data URL of the overlaid canvas.
 */
async function overlayCanvases(segmentDataUrls, targetWidth, targetHeight) {
	if (
		!segmentDataUrls ||
		segmentDataUrls.length === 0 ||
		targetWidth <= 0 ||
		targetHeight <= 0
	) {
		console.warn('overlayCanvases received invalid inputs.');
		return '';
	}

	const canvas = createCanvas(targetWidth, targetHeight);
	const ctx = canvas.getContext('2d');

	// Ensure background is transparent or white for proper overlay if desired
	ctx.clearRect(0, 0, targetWidth, targetHeight); // Clear to transparent

	// Load all images and draw them onto the canvas
	for (const dataUrl of segmentDataUrls) {
		if (!dataUrl) continue;
		const img = new Image();
		img.src = dataUrl;

		await new Promise((resolve) => {
			img.onload = () => {
				// Draw each image scaled to fit the target dimensions
				ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
				resolve();
			};
			img.onerror = (err) => {
				console.warn(
					'Failed to load image for overlay:',
					err,
					dataUrl.substring(0, 50) + '...'
				);
				resolve();
			};
		});
	}

	return canvas.toDataURL();
}

/**
 * Creates a new canvas of target dimensions and draws the bottom portion of a source image onto its bottom.
 * The rest of the target canvas remains transparent.
 * @param {string} fullPreviousDrawingDataUrl The base64 data URL of the complete previous drawing.
 * @param {number} peekHeight The height of the peek portion from the bottom of the source image.
 * @param {number} targetWidth The desired width of the resulting canvas.
 * @param {number} targetHeight The desired height of the resulting canvas.
 * @returns {Promise<string>} A promise that resolves with the base64 data URL of the new canvas with the peek.
 */
async function createCanvasWithBottomPeek(
	fullPreviousDrawingDataUrl,
	peekHeight,
	targetWidth,
	targetHeight
) {
	if (
		!fullPreviousDrawingDataUrl ||
		peekHeight <= 0 ||
		targetWidth <= 0 ||
		targetHeight <= 0
	) {
		console.warn('createCanvasWithBottomPeek received invalid inputs.');
		// Return an empty canvas data URL for consistency
		const emptyCanvas = createCanvas(targetWidth, targetHeight);
		return emptyCanvas.toDataURL();
	}

	const img = new Image();
	img.src = fullPreviousDrawingDataUrl;

	return new Promise((resolve, reject) => {
		img.onload = () => {
			const sourceWidth = img.width;
			const sourceHeight = img.height;

			const canvas = createCanvas(targetWidth, targetHeight);
			const ctx = canvas.getContext('2d');

			// Clear the canvas to ensure transparency
			ctx.clearRect(0, 0, targetWidth, targetHeight);

			// Calculate the source Y-coordinate to start drawing from the bottom of the source image
			const sourceY = Math.max(0, sourceHeight - peekHeight); // Ensure not negative

			// Calculate the actual height to draw from the source
			const actualPeekHeight = sourceHeight - sourceY;

			// Calculate destination Y-coordinate on the target canvas (at the very bottom)
			const destY = targetHeight - actualPeekHeight;

			ctx.drawImage(
				img,
				0, // Source X
				sourceY, // Source Y (start from bottom of source image)
				sourceWidth, // Source Width
				actualPeekHeight, // Source Height (portion to draw)
				0, // Destination X
				destY, // Destination Y (draw at bottom of target canvas)
				targetWidth, // Destination Width (stretch to target width if necessary, though ideally sourceWidth == targetWidth)
				actualPeekHeight // Destination Height
			);

			resolve(canvas.toDataURL());
		};
		img.onerror = (err) => {
			console.error(
				'Failed to load image for createCanvasWithBottomPeek:',
				err,
				fullPreviousDrawingDataUrl.substring(0, 50) + '...'
			);
			// Even if image fails, return a blank canvas to prevent blocking
			const emptyCanvas = createCanvas(targetWidth, targetHeight);
			resolve(emptyCanvas.toDataURL());
		};
	});
}

module.exports = {
	combineCanvases,
	overlayCanvases,
	createCanvasWithBottomPeek,
};
