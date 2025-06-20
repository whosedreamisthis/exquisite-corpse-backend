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
		await new Promise((resolve, reject) => {
			img.onload = () => {
				totalHeight += img.height;
				if (img.width > maxWidth) {
					maxWidth = img.width;
				}
				resolve();
			};
			img.onerror = (err) => {
				console.error(
					'Failed to load image for combination:',
					err,
					dataUrl.substring(0, 50) + '...'
				);
				// Even if an image fails, we try to combine what we have, so resolve but log error
				resolve();
			};
		});
	}

	if (images.length === 0 || maxWidth === 0 || totalHeight === 0) {
		console.warn(
			'No valid images loaded for combination or dimensions are zero.'
		);
		return ''; // Cannot combine if no valid images or zero dimensions
	}

	// Create a new canvas element
	const canvas = createCanvas(maxWidth, totalHeight); // Using 'canvas' npm package for Node.js
	const ctx = canvas.getContext('2d');

	let currentY = 0;
	for (const img of images) {
		if (img.width > 0 && img.height > 0) {
			// Only draw if image loaded successfully
			ctx.drawImage(img, 0, currentY, maxWidth, img.height);
			currentY += img.height;
		}
	}

	return canvas.toDataURL();
}

/**
 * Overlays an array of base64 image data URLs onto a single canvas.
 * Assumes all images are meant to be overlaid on the same canvas area.
 * @param {string[]} segmentDataUrls An array of base64 data URLs for images to overlay.
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
					dataUrl.substring(0, 50) + '...',
					err
				);
				resolve(); // Still resolve to continue with other images
			};
		});
	}

	return canvas.toDataURL();
}

module.exports = { combineCanvases, overlayCanvases };
