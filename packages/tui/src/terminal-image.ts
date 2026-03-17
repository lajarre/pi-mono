export type ImageProtocol = "kitty" | "iterm2" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	preserveAspectRatio?: boolean;
	/** Kitty image ID. If provided, reuses/replaces existing image with this ID. */
	imageId?: number;
}

let cachedCapabilities: TerminalCapabilities | null = null;

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

export function detectCapabilities(): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "vscode") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (termProgram === "alacritty") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	const trueColor = colorTerm === "truecolor" || colorTerm === "24bit";
	return { images: null, trueColor, hyperlinks: true };
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		cachedCapabilities = detectCapabilities();
	}
	return cachedCapabilities;
}

export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";

function maybeWrapTmuxPassthrough(sequence: string): string {
	if (!process.env.TMUX) {
		return sequence;
	}

	return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		return true;
	}
	// Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
	if (line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX)) {
		return true;
	}
	// Unicode placeholder lines (U+10EEEE) are also image content
	return line.includes(PLACEHOLDER_CHAR);
}

/**
 * Generate a random image ID for Kitty graphics protocol.
 * Uses random IDs to avoid collisions between different module instances
 * (e.g., main app vs extensions).
 * Range limited to 24-bit [1, 0xffffff] so IDs can be encoded in
 * true-color foreground values for Unicode placeholder mode.
 */
export function allocateImageId(): number {
	return Math.floor(Math.random() * 0xffffff) + 1;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return maybeWrapTmuxPassthrough(`\x1b_G${params.join(",")};${base64Data}\x1b\\`);
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(maybeWrapTmuxPassthrough(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`));
			isFirst = false;
		} else if (isLast) {
			chunks.push(maybeWrapTmuxPassthrough(`\x1b_Gm=0;${chunk}\x1b\\`));
		} else {
			chunks.push(maybeWrapTmuxPassthrough(`\x1b_Gm=1;${chunk}\x1b\\`));
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 */
export function deleteKittyImage(imageId: number): string {
	return maybeWrapTmuxPassthrough(`\x1b_Ga=d,d=I,i=${imageId}\x1b\\`);
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 */
export function deleteAllKittyImages(): string {
	return maybeWrapTmuxPassthrough(`\x1b_Ga=d,d=A\x1b\\`);
}

// ---------------------------------------------------------------------------
// Kitty Unicode placeholder support — for correct image rendering inside tmux.
//
// With DCS passthrough the terminal places images at the real cursor
// position, which can be in the wrong pane after a tmux split.  Unicode
// placeholders tie image cells to text characters that flow through
// tmux's virtual terminal, so pane boundaries are respected.
//
// Protocol reference:
//   https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
// ---------------------------------------------------------------------------

/** U+10EEEE — Kitty image placeholder character. */
const PLACEHOLDER_CHAR = String.fromCodePoint(0x10eeee);

/**
 * Combining diacritics used by the Kitty protocol to encode row/column
 * numbers inside Unicode placeholders.  Index 0 → diacritic for value 0,
 * index 1 → value 1, etc.  Derived from the canonical diacritics table
 * shipped with Kitty (rowcolumn-diacritics.txt, Unicode 6.0.0,
 * combining class 230, no decomposition mappings).
 *
 * 297 entries → supports row/column values 0–296.
 *
 * Reference implementation: yazi file manager uses the same table
 * (yazi-adapter/src/drivers/kgp.rs, DIACRITICS array).
 */
// prettier-ignore
const KITTY_DIACRITICS: string[] = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351,
	0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d,
	0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599,
	0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
	0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6,
	0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4, 0x06e7, 0x06e8, 0x06eb,
	0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747,
	0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817, 0x0818, 0x0819,
	0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a,
	0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd,
	0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f,
	0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4,
	0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7,
	0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5,
	0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0,
	0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea,
	0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8,
	0x2df9, 0x2dfa, 0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
	0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef,
	0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23,
	0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac,
	0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
].map((cp) => String.fromCodePoint(cp));

/**
 * Build one row of Unicode placeholder text for a Kitty image.
 *
 * Encodes the image ID in the true-color foreground (24 bits) and the
 * row number via a combining diacritic on the first cell.  Subsequent
 * cells on the same row carry no diacritics — the terminal inherits
 * the row and auto-increments the column.
 */
function buildPlaceholderRow(imageId: number, row: number, columns: number): string {
	const r = (imageId >> 16) & 0xff;
	const g = (imageId >> 8) & 0xff;
	const b = imageId & 0xff;

	const rowDiac = KITTY_DIACRITICS[row] ?? KITTY_DIACRITICS[0]!;

	let line = `\x1b[38;2;${r};${g};${b}m`;
	// First cell: placeholder + row diacritic (column defaults to 0)
	line += PLACEHOLDER_CHAR + rowDiac;
	// Remaining cells: bare placeholder (inherits row, auto-increments col)
	for (let c = 1; c < columns; c++) {
		line += PLACEHOLDER_CHAR;
	}
	line += "\x1b[39m";
	return line;
}

/**
 * Encode a Kitty image using the Unicode placeholder protocol.
 *
 * Returns:
 * - `uploadSequence`: APC command(s) wrapped in DCS passthrough that
 *   transmit the image data and create a virtual placement.
 * - `placeholderLines`: one string per row of placeholder text that
 *   must be emitted as normal terminal output (NOT DCS-wrapped).
 */
export function encodeKittyPlaceholder(
	base64Data: string,
	options: {
		columns: number;
		rows: number;
		imageId: number;
	},
): { uploadSequence: string; placeholderLines: string[] } {
	const CHUNK_SIZE = 4096;

	// a=T  — transmit + display (combined with U=1 → virtual placement)
	// U=1  — use Unicode placeholders for this image
	// f=100 — PNG data
	// q=2  — suppress terminal responses
	const params: string[] = [
		"a=T",
		"U=1",
		"f=100",
		"q=2",
		`i=${options.imageId}`,
		`c=${options.columns}`,
		`r=${options.rows}`,
	];

	let uploadSequence: string;

	if (base64Data.length <= CHUNK_SIZE) {
		uploadSequence = maybeWrapTmuxPassthrough(`\x1b_G${params.join(",")};${base64Data}\x1b\\`);
	} else {
		const chunks: string[] = [];
		let offset = 0;
		let isFirst = true;
		while (offset < base64Data.length) {
			const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
			const isLast = offset + CHUNK_SIZE >= base64Data.length;
			if (isFirst) {
				chunks.push(maybeWrapTmuxPassthrough(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`));
				isFirst = false;
			} else if (isLast) {
				chunks.push(maybeWrapTmuxPassthrough(`\x1b_Gm=0;${chunk}\x1b\\`));
			} else {
				chunks.push(maybeWrapTmuxPassthrough(`\x1b_Gm=1;${chunk}\x1b\\`));
			}
			offset += CHUNK_SIZE;
		}
		uploadSequence = chunks.join("");
	}

	const placeholderLines: string[] = [];
	for (let row = 0; row < options.rows; row++) {
		placeholderLines.push(buildPlaceholderRow(options.imageId, row, options.columns));
	}

	return { uploadSequence, placeholderLines };
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
	const scale = targetWidthPx / imageDimensions.widthPx;
	const scaledHeightPx = imageDimensions.heightPx * scale;
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);
	return Math.max(1, rows);
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export interface ImageRenderResult {
	sequence: string;
	rows: number;
	imageId?: number;
	/** When set, the image uses Kitty Unicode placeholders (tmux mode). */
	placeholderLines?: string[];
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): ImageRenderResult | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	const rows = calculateImageRows(imageDimensions, maxWidth, getCellDimensions());

	if (caps.images === "kitty") {
		// Kitty `f=100` expects PNG data. Fall back if callers pass another format.
		if (!getPngDimensions(base64Data)) {
			return null;
		}

		// Inside tmux: use Unicode placeholders so images stay in their
		// pane on splits/resizes instead of leaking to adjacent panes.
		if (process.env.TMUX && options.imageId) {
			const { uploadSequence, placeholderLines } = encodeKittyPlaceholder(base64Data, {
				columns: maxWidth,
				rows,
				imageId: options.imageId,
			});
			return {
				sequence: uploadSequence,
				rows,
				imageId: options.imageId,
				placeholderLines,
			};
		}

		// Direct placement (no tmux).
		const sequence = encodeKitty(base64Data, { columns: maxWidth, rows, imageId: options.imageId });
		return { sequence, rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: maxWidth,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, rows };
	}

	return null;
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
