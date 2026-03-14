/**
 * Tests for terminal image detection and line handling
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Image } from "../src/components/image.js";
import {
	deleteAllKittyImages,
	deleteKittyImage,
	encodeKitty,
	isImageLine,
	resetCapabilitiesCache,
} from "../src/terminal-image.js";

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
	const previous = process.env[key];
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		if (previous === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = previous;
		}
	}
}

function withTmuxEnv<T>(value: string | undefined, fn: () => T): T {
	return withEnv("TMUX", value, fn);
}

describe("terminal image helpers", () => {
	describe("Kitty tmux passthrough", () => {
		it("should emit raw Kitty sequences outside tmux", () => {
			const sequence = withTmuxEnv(undefined, () => encodeKitty("QUJD", { columns: 10, rows: 4, imageId: 7 }));
			assert.strictEqual(sequence, "\x1b_Ga=T,f=100,q=2,c=10,r=4,i=7;QUJD\x1b\\");
		});

		it("should wrap Kitty sequences for tmux passthrough", () => {
			const sequence = withTmuxEnv("/tmp/tmux,123,0", () => encodeKitty("QUJD", { columns: 10, rows: 4 }));
			assert.strictEqual(sequence, "\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,c=10,r=4;QUJD\x1b\x1b\\\x1b\\");
		});

		it("should wrap each Kitty chunk separately for tmux passthrough", () => {
			const payload = "A".repeat(5000);
			const sequence = withTmuxEnv("/tmp/tmux,123,0", () => encodeKitty(payload));
			assert.strictEqual(sequence.match(/\x1bPtmux;/g)?.length, 2);
			assert.strictEqual(sequence.match(/\x1b\\/g)?.length, 4);
			assert.ok(sequence.includes("\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,m=1;"));
			assert.ok(sequence.includes("\x1bPtmux;\x1b\x1b_Gm=0;"));
		});

		it("should wrap Kitty delete helpers for tmux passthrough", () => {
			const deleteOne = withTmuxEnv("/tmp/tmux,123,0", () => deleteKittyImage(42));
			const deleteAll = withTmuxEnv("/tmp/tmux,123,0", () => deleteAllKittyImages());
			assert.strictEqual(deleteOne, "\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=42\x1b\x1b\\\x1b\\");
			assert.strictEqual(deleteAll, "\x1bPtmux;\x1b\x1b_Ga=d,d=A\x1b\x1b\\\x1b\\");
		});

		it("should still recognize wrapped Kitty output as an image line", () => {
			const sequence = withTmuxEnv("/tmp/tmux,123,0", () => encodeKitty("QUJD"));
			assert.strictEqual(isImageLine(sequence), true);
		});
	});

	describe("Image component", () => {
		it("should allocate and reuse a stable Kitty image ID across rerenders", () => {
			withEnv("TERM_PROGRAM", "kitty", () => {
				resetCapabilitiesCache();
				const image = new Image(
					"QUJD",
					"image/png",
					{ fallbackColor: (s) => s },
					{ maxWidthCells: 10 },
					{ widthPx: 100, heightPx: 50 },
				);

				const firstLines = image.render(20);
				const firstImageId = image.getImageId();
				assert.ok(firstImageId);
				assert.ok(firstLines.at(-1)?.includes(`i=${firstImageId}`));
				assert.ok(firstLines.at(-1)?.startsWith(`\x1b[${firstLines.length - 1}A`));
				assert.ok(firstLines.at(-1)?.endsWith(`\x1b[${firstLines.length - 1}B`));

				image.invalidate();
				const secondLines = image.render(20);
				assert.strictEqual(image.getImageId(), firstImageId);
				assert.ok(secondLines.at(-1)?.includes(`i=${firstImageId}`));
				assert.ok(secondLines.at(-1)?.endsWith(`\x1b[${secondLines.length - 1}B`));
				resetCapabilitiesCache();
			});
		});
	});

	describe("isImageLine", () => {
		describe("iTerm2 image protocol", () => {
			it("should detect iTerm2 image escape sequence at start of line", () => {
				// iTerm2 image escape sequence: ESC ]1337;File=...
				const iterm2ImageLine = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07";
				assert.strictEqual(isImageLine(iterm2ImageLine), true);
			});

			it("should detect iTerm2 image escape sequence with text before it", () => {
				// Simulating a line that has text then image data (bug scenario)
				const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
				assert.strictEqual(isImageLine(lineWithTextAndImage), true);
			});

			it("should detect iTerm2 image escape sequence in middle of long line", () => {
				// Simulate a very long line with image data in the middle
				const longLineWithImage =
					"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
				assert.strictEqual(isImageLine(longLineWithImage), true);
			});

			it("should detect iTerm2 image escape sequence at end of line", () => {
				const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
				assert.strictEqual(isImageLine(lineWithImageAtEnd), true);
			});

			it("should detect minimal iTerm2 image escape sequence", () => {
				const minimalImageLine = "\x1b]1337;File=:\x07";
				assert.strictEqual(isImageLine(minimalImageLine), true);
			});
		});

		describe("Kitty image protocol", () => {
			it("should detect Kitty image escape sequence at start of line", () => {
				// Kitty image escape sequence: ESC _G
				const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
				assert.strictEqual(isImageLine(kittyImageLine), true);
			});

			it("should detect Kitty image escape sequence with text before it", () => {
				// Bug scenario: text + image data in same line
				const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
				assert.strictEqual(isImageLine(lineWithTextAndKittyImage), true);
			});

			it("should detect Kitty image escape sequence with padding", () => {
				// Kitty protocol adds padding to escape sequences
				const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
				assert.strictEqual(isImageLine(kittyWithPadding), true);
			});
		});

		describe("Bug regression tests", () => {
			it("should detect image sequences in very long lines (304k+ chars)", () => {
				// This simulates the crash scenario: a line with 304,401 chars
				// containing image escape sequences somewhere
				const base64Char = "A".repeat(100); // 100 chars of base64-like data
				const imageSequence = "\x1b]1337;File=size=800,600;inline=1:";

				// Build a long line with image sequence
				const longLine =
					"Text prefix " +
					imageSequence +
					base64Char.repeat(3000) + // ~300,000 chars
					" suffix";

				assert.strictEqual(longLine.length > 300000, true);
				assert.strictEqual(isImageLine(longLine), true);
			});

			it("should detect image sequences when terminal doesn't support images", () => {
				// The bug occurred when getImageEscapePrefix() returned null
				// isImageLine should still detect image sequences regardless
				const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
				assert.strictEqual(isImageLine(lineWithImage), true);
			});

			it("should detect image sequences with ANSI codes before them", () => {
				// Text might have ANSI styling before image data
				const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
				assert.strictEqual(isImageLine(lineWithAnsiAndImage), true);
			});

			it("should detect image sequences with ANSI codes after them", () => {
				const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
				assert.strictEqual(isImageLine(lineWithImageAndAnsi), true);
			});
		});

		describe("Negative cases - lines without images", () => {
			it("should not detect images in plain text lines", () => {
				const plainText = "This is just a regular text line without any escape sequences";
				assert.strictEqual(isImageLine(plainText), false);
			});

			it("should not detect images in lines with only ANSI codes", () => {
				const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
				assert.strictEqual(isImageLine(ansiText), false);
			});

			it("should not detect images in lines with cursor movement codes", () => {
				const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
				assert.strictEqual(isImageLine(cursorCodes), false);
			});

			it("should not detect images in lines with partial iTerm2 sequences", () => {
				// Similar prefix but missing the complete sequence
				const partialSequence = "Some text with ]1337;File but missing ESC at start";
				assert.strictEqual(isImageLine(partialSequence), false);
			});

			it("should not detect images in lines with partial Kitty sequences", () => {
				// Similar prefix but missing the complete sequence
				const partialSequence = "Some text with _G but missing ESC at start";
				assert.strictEqual(isImageLine(partialSequence), false);
			});

			it("should not detect images in empty lines", () => {
				assert.strictEqual(isImageLine(""), false);
			});

			it("should not detect images in lines with newlines only", () => {
				assert.strictEqual(isImageLine("\n"), false);
				assert.strictEqual(isImageLine("\n\n"), false);
			});
		});

		describe("Mixed content scenarios", () => {
			it("should detect images when line has both Kitty and iTerm2 sequences", () => {
				const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
				assert.strictEqual(isImageLine(mixedLine), true);
			});

			it("should detect image in line with multiple text and image segments", () => {
				const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
				assert.strictEqual(isImageLine(complexLine), true);
			});

			it("should not falsely detect image in line with file path containing keywords", () => {
				// File path might contain "1337" or "File" but without escape sequences
				const filePathLine = "/path/to/File_1337_backup/image.jpg";
				assert.strictEqual(isImageLine(filePathLine), false);
			});
		});
	});
});
