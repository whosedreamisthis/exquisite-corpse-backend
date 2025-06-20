// canvas-utils.js

// IMPORTANT: Ensure 'canvas' npm package is installed: npm install canvas
// For 'canvas' package, you might need system dependencies like Cairo.
// On Ubuntu/Debian: sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
// On macOS: brew install cairo pango libjpeg giflib librsvg
// On Windows: More complex, typically involves installing GTK+ or compiling. See node-canvas GitHub for details.
const { createCanvas, Image } = require('canvas');

/**
 * Combines an array of base64 image data URLs (canvas segments) into a single base64 image.
 * Each segment is assumed to be the same width and will be stacked vertically.
 * @param {string[]} segmentDataUrls An array of base64 data URLs for each canvas segment.
 * @returns {Promise<string>} A promise that resolves with the base64 data URL of the combined canvas.
 */
async function combineCanvases(segmentDataUrls) {
	if (!segmentDataUrls || segmentDataUrls.length === 0) {
		console.warn(
			'COMBINE: combineCanvases received no segments to combine.'
		);
		return ''; // Return an empty string if no segments
	}

	console.log(
		`COMBINE: Starting combineCanvases with ${segmentDataUrls.length} segments.`
	);
	console.log(
		`COMBINE: First segment dataUrl length: ${
			segmentDataUrls[0] ? segmentDataUrls[0].length : 'N/A'
		}`
	); // NEW LOG
	console.log(
		`COMBINE: Second segment dataUrl length: ${
			segmentDataUrls[1] ? segmentDataUrls[1].length : 'N/A'
		}`
	); // NEW LOG

	// Load all images first to determine total dimensions
	const images = [];
	let totalHeight = 0;
	let maxWidth = 0;

	for (let i = 0; i < segmentDataUrls.length; i++) {
		const dataUrl = segmentDataUrls[i];
		if (!dataUrl) {
			console.warn(
				`COMBINE: Skipping null or empty segmentDataUrl at index ${i}.`
			);
			continue;
		}
		try {
			const img = new Image();
			img.src = dataUrl;
			images.push(img);

			await new Promise((resolve, reject) => {
				img.onload = () => {
					if (img.width > maxWidth) {
						maxWidth = img.width;
					}
					totalHeight += img.height;
					resolve();
				};
				img.onerror = (err) => {
					console.error(
						`COMBINE ERROR: Failed to load image from dataUrl (index ${i}):`,
						err
					);
					reject(
						new Error(
							`Failed to load image for combineCanvases at index ${i}`
						)
					);
				};
			});
		} catch (loadErr) {
			console.error(
				`COMBINE ERROR: Caught error during image loading setup (index ${i}):`,
				loadErr
			);
			throw loadErr;
		}
	}

	if (images.length === 0) {
		console.warn('COMBINE: No valid images loaded for combination.');
		return '';
	}

	console.log(
		`COMBINE: All images loaded. MaxWidth: ${maxWidth}, TotalHeight: ${totalHeight}. Creating canvas...`
	);
	const canvas = createCanvas(maxWidth, totalHeight);
	const ctx = canvas.getContext('2d');

	let currentY = 0;
	for (let i = 0; i < images.length; i++) {
		const img = images[i];
		try {
			ctx.drawImage(img, 0, currentY, maxWidth, img.height);
			currentY += img.height;
			console.log(
				`COMBINE: Drew image ${i} at Y=${currentY - img.height}.`
			);
		} catch (drawErr) {
			console.error(
				`COMBINE ERROR: Failed to draw image (index ${i}) onto canvas:`,
				drawErr
			);
			throw drawErr;
		}
	}

	const resultDataUrl = canvas.toDataURL('image/png');
	console.log('COMBINE: combineCanvases finished successfully.');
	return resultDataUrl;
}

/**
 * Overlays multiple base64 image data URLs onto a single canvas of specified dimensions.
 * Useful for combining multiple player segments into a single transparent layer, or adding a new layer to a background.
 * @param {string[]} segmentDataUrls An array of base64 data URLs for images to overlay.
 * @param {number} targetWidth The desired width of the resulting canvas.
 * @param {number} targetHeight The desired height of the resulting canvas.
 * @returns {Promise<string>} A promise that resolves with the base64 data URL of the overlaid canvas.
 */
async function overlayCanvases(segmentDataUrls, targetWidth, targetHeight) {
	console.log(`OVERLAY: Entering overlayCanvases function.`);
	console.log(`OVERLAY: Received ${segmentDataUrls.length} data URLs.`); // NEW LOG
	console.log(`OVERLAY: Target dimensions: ${targetWidth}x${targetHeight}.`); // NEW LOG
	if (segmentDataUrls[0]) {
		console.log(
			`OVERLAY: First dataUrl length: ${segmentDataUrls[0].length}`
		); // NEW LOG
		console.log(
			`OVERLAY: First dataUrl starts with: ${segmentDataUrls[0].substring(
				0,
				50
			)}...`
		); // NEW LOG
	}
	if (segmentDataUrls[1]) {
		console.log(
			`OVERLAY: Second dataUrl length: ${segmentDataUrls[1].length}`
		); // NEW LOG
		console.log(
			`OVERLAY: Second dataUrl starts with: ${segmentDataUrls[1].substring(
				0,
				50
			)}...`
		); // NEW LOG
	}

	if (!segmentDataUrls || segmentDataUrls.length === 0) {
		console.warn(
			'OVERLAY: overlayCanvases received no segments to overlay or invalid inputs.'
		);
		return '';
	}
	if (targetWidth <= 0 || targetHeight <= 0) {
		console.warn(
			`OVERLAY: Invalid target dimensions: Width=${targetWidth}, Height=${targetHeight}.`
		);
		return '';
	}

	try {
		console.log(
			`OVERLAY: Creating canvas with dimensions ${targetWidth}x${targetHeight}.`
		);
		const canvas = createCanvas(targetWidth, targetHeight);
		const ctx = canvas.getContext('2d');

		ctx.clearRect(0, 0, targetWidth, targetHeight);
		console.log(`OVERLAY: Canvas created and cleared.`);

		for (let i = 0; i < segmentDataUrls.length; i++) {
			const dataUrl = segmentDataUrls[i];
			if (!dataUrl) {
				console.warn(
					`OVERLAY: Skipping null or empty dataUrl at index ${i}.`
				);
				continue;
			}

			try {
				const img = new Image();
				img.src = dataUrl;
				console.log(
					`OVERLAY: Loading image from dataUrl (index ${i})...`
				);

				await new Promise((resolve, reject) => {
					img.onload = () => {
						try {
							ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
							console.log(
								`OVERLAY: Successfully drew image ${i}.`
							);
							resolve();
						} catch (drawErr) {
							console.error(
								`OVERLAY ERROR: Error drawing image ${i} onto canvas:`,
								drawErr
							);
							reject(drawErr);
						}
					};
					img.onerror = (err) => {
						console.error(
							`OVERLAY ERROR: Failed to load image from dataUrl (index ${i}):`,
							err
						);
						reject(
							new Error(
								`Failed to load image for overlay at index ${i}`
							)
						);
					};
				});
			} catch (loadOrDrawErr) {
				console.error(
					`OVERLAY ERROR: Caught error during image processing loop (index ${i}):`,
					loadOrDrawErr
				);
				throw loadOrDrawErr;
			}
		}

		const resultDataUrl = canvas.toDataURL('image/png');
		console.log(
			'OVERLAY: overlayCanvases finished successfully, returning data URL.'
		);
		return resultDataUrl;
	} catch (overallErr) {
		console.error(
			'OVERLAY FATAL ERROR: An unhandled error occurred in overlayCanvases:',
			overallErr
		);
		throw overallErr;
	}
}

module.exports = {
	combineCanvases,
	overlayCanvases,
};
