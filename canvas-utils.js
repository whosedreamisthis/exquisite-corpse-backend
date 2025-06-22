// canvas-utils.js

// IMPORTANT: Ensure 'canvas' npm package is installed: npm install canvas
const { createCanvas, Image } = require('canvas');

/**
 * Creates a blank canvas and returns its data URL.
 * @param {number} width The width of the canvas.
 * @param {number} height The height of the canvas.
 * @returns {string} The data URL of the blank canvas.
 */
function createBlankCanvas(width, height) {
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext('2d');
	ctx.clearRect(0, 0, width, height); // Ensure it's transparent
	return canvas.toDataURL();
}

/**
 * Combines an array of base64 image data URLs (canvas segments) into a single base64 image.
 * Each segment is assumed to be the same width and will be stacked vertically.
 * @param {string[]} segmentDataUrls An array of base64 data URLs for each canvas segment.
 * @returns {Promise<string>} A promise that resolves with the base64 data URL of the combined canvas.
 */
async function combineCanvases(segmentDataUrls) {
	console.log('combineCanvases 1');
	if (!segmentDataUrls || segmentDataUrls.length === 0) {
		console.warn('combineCanvases received no segments to combine.');
		return ''; // Return an empty string if no segments
	}

	// Load all images first to determine total dimensions
	const images = [];
	let totalHeight = 0;
	let maxWidth = 0; // Assuming all segments have the same width, but we'll find the max just in case
	console.log('combineCanvases 2');

	// Use a traditional for loop to properly await each image load and handle potential issues
	for (let i = 0; i < segmentDataUrls.length; i++) {
		const dataUrl = segmentDataUrls[i];
		console.log('combineCanvases 3'); // This is from your original loop start

		if (!dataUrl) {
			console.warn(
				`Skipping null or empty segmentDataUrl for segment ${i}. Creating a blank placeholder.`
			);
			// Create a blank image to push, so the loop doesn't break
			const blankImg = new Image();
			// Setting a tiny blank data URL to satisfy onload for blank parts
			blankImg.src = createBlankCanvas(1, 1); // Smallest possible blank canvas

			await new Promise((resolve) => {
				blankImg.onload = () => {
					// Assign approximate dimensions for the placeholder to avoid issues with zero width/height
					blankImg.width = 800; // Assuming CANVAS_WIDTH
					blankImg.height = 150; // Assuming SEGMENT_HEIGHT
					totalHeight += blankImg.height;
					if (blankImg.width > maxWidth) {
						maxWidth = blankImg.width;
					}
					images.push(blankImg); // Push the placeholder image
					resolve();
				};
				blankImg.onerror = () => {
					console.error(
						`Failed to load internal blank placeholder for segment ${i}. This should not happen.`
					);
					// Fallback dimensions if even the blank fails
					blankImg.width = 800;
					blankImg.height = 150;
					totalHeight += blankImg.height;
					if (blankImg.width > maxWidth) {
						maxWidth = blankImg.width;
					}
					images.push(blankImg);
					resolve();
				};
			});
			continue; // Skip to next iteration in the main loop
		}

		const img = new Image();
		// Crucial Fix: Attach onload/onerror BEFORE setting src
		await new Promise((resolve) => {
			console.log('combineCanvases 3a');
			img.onload = () => {
				totalHeight += img.height;
				if (img.width > maxWidth) {
					maxWidth = img.width;
				}
				images.push(img); // Push the loaded image
				resolve();
			};
			console.log('combineCanvases 3b');
			img.onerror = (err) => {
				console.error(
					'Failed to load image in combineCanvases:',
					err,
					dataUrl.substring(0, 50) + '...'
				);
				// Important: Resolve even on error to prevent blocking.
				// We'll handle drawing a placeholder or skipping this image later.
				const brokenImg = new Image(); // Create a new image object for the placeholder
				brokenImg.isBroken = true; // Custom flag to indicate it failed to load
				brokenImg.width = 800; // Provide fallback dimensions
				brokenImg.height = 150; // Provide fallback dimensions
				totalHeight += brokenImg.height;
				if (brokenImg.width > maxWidth) {
					maxWidth = brokenImg.width;
				}
				images.push(brokenImg); // Push the placeholder image
				resolve(); // Resolve the promise to unblock the await
			};
			console.log('combineCanvases 3c');
			img.src = dataUrl; // Set src AFTER handlers are attached
		});
		console.log('combineCanvases 4'); // This will now be reached
	}

	if (images.length === 0) {
		console.warn('No valid images to combine.');
		return '';
	}

	// Fallback for maxWidth and totalHeight if no valid images had dimensions or only placeholders
	if (maxWidth === 0) maxWidth = 800; // Default to common canvas width if no valid image dimensions found
	if (totalHeight === 0) {
		// If totalHeight is 0, it means either no images or all were placeholders with 0 height initially
		totalHeight = images.length * 150; // Estimate based on number of segments (assuming default SEGMENT_HEIGHT)
	}

	// Create a new canvas to draw all combined segments
	const canvas = createCanvas(maxWidth, totalHeight);
	const ctx = canvas.getContext('2d');

	// Draw each image onto the new canvas, stacking them vertically
	let currentY = 0;
	for (let i = 0; i < images.length; i++) {
		const img = images[i];
		if (img.isBroken || img.width === 0 || img.height === 0) {
			console.warn(
				`[COMBINE_WARN] Skipping drawing problematic image ${i}. Drawing a red placeholder.`
			);
			ctx.fillStyle = 'red';
			// Draw a red rectangle as a placeholder
			ctx.fillRect(0, currentY, maxWidth, img.height || 150); // Use image's height or fallback
			currentY += img.height || 150;
			continue;
		}
		try {
			ctx.drawImage(img, 0, currentY, maxWidth, img.height);
			currentY += img.height;
		} catch (drawErr) {
			console.error(
				`[COMBINE_ERROR] Error drawing image ${i} onto final canvas:`,
				drawErr
			);
			ctx.fillStyle = 'red'; // Draw red placeholder on drawing error as well
			ctx.fillRect(0, currentY, maxWidth, img.height || 150);
			currentY += img.height || 150;
		}
	}

	return canvas.toDataURL();
}

/**
 * Creates a new canvas that contains the bottom 'peekHeight' pixels
 * of a given drawing, positioned at the bottom of the new canvas.
 * The top portion of the new canvas will be transparent.
 *
 * @param {string} fullPreviousDrawingDataUrl The data URL of the full previous drawing.
 * @param {number} targetWidth The desired width of the new canvas.
 * @param {number} targetHeight The desired height of the new canvas.
 * @param {number} peekHeight The height of the portion to peek from the bottom of the previous drawing.
 * @returns {Promise<string>} A promise that resolves with the data URL of the new canvas with the peek.
 */
// REMOVED: This function is no longer needed as the red line is dynamic on the frontend.
// async function createCanvasWithBottomPeek(
//  fullPreviousDrawingDataUrl,
//  targetWidth,
//  targetHeight,
//  peekHeight
// ) {
//  return new Promise((resolve, reject) => {
//      const img = new Image();
//      img.src = fullPreviousDrawingDataUrl;

//      img.onload = () => {
//          const sourceWidth = img.width;
//          const sourceHeight = img.height;

//          const canvas = createCanvas(targetWidth, targetHeight);
//          const ctx = canvas.getContext('2d');

//          // Clear the canvas to ensure transparency
//          ctx.clearRect(0, 0, targetWidth, targetHeight);

//          // Calculate the source Y-coordinate to start drawing from the bottom of the source image
//          const sourceY = Math.max(0, sourceHeight - peekHeight); // Ensure not negative

//          // Calculate the actual height to draw from the source
//          const actualPeekHeight = sourceHeight - sourceY;

//          // Calculate destination Y-coordinate on the target canvas (at the very bottom)
//          const destY = targetHeight - actualPeekHeight;

//          ctx.drawImage(
//              img,
//              0, // Source X
//              sourceY, // Source Y (start from bottom of source image)
//              sourceWidth, // Source Width
//              actualPeekHeight, // Source Height (portion to draw)
// 0, // Destination X
//              destY, // Destination Y (draw at bottom of target canvas)
//              targetWidth, // Destination Width (stretch to target width if necessary, though ideally sourceWidth == targetWidth)
//              actualPeekHeight // Destination Height
//          );

//          resolve(canvas.toDataURL());
//      };
//      img.onerror = (err) => {
//          console.error(
//              'Failed to load image for createCanvasWithBottomPeek:',
//              err,
//              fullPreviousDrawingDataUrl.substring(0, 50) + '...'
//          );
//          // Even if image fails, return a blank canvas to prevent blocking
//          const emptyCanvas = createCanvas(targetWidth, targetHeight);
//          resolve(emptyCanvas.toDataURL());
//      };
//  });
// }

module.exports = {
	combineCanvases,
	// createCanvasWithBottomPeek, // REMOVED: No longer export this function
	createBlankCanvas, // Export the new function
};
