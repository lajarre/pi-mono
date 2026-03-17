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
	encodeKittyPlaceholder,
	isImageLine,
	renderImage,
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

const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cJ6kAAAAASUVORK5CYII=";

function withTmuxEnv<T>(value: string | undefined, fn: () => T): T {
	return withEnv("TMUX", value, fn);
}

function withCapabilitiesReset<T>(fn: () => T): T {
	resetCapabilitiesCache();
	try {
		return fn();
	} finally {
		resetCapabilitiesCache();
	}
}

function withClearedKittyLikeEnv<T>(fn: () => T): T {
	return withEnv("KITTY_WINDOW_ID", undefined, () =>
		withEnv("WEZTERM_PANE", undefined, () =>
			withEnv("GHOSTTY_RESOURCES_DIR", undefined, () => withEnv("TERM", "xterm-256color", fn)),
		),
	);
}

describe("terminal image helpers", () => {
	describe("Kitty tmux passthrough", () => {
		it("should emit raw Kitty sequences outside tmux", () => {
			const sequence = withTmuxEnv(undefined, () => encodeKitty("QUJD", { columns: 10, rows: 4, imageId: 7 }));
			assert.strictEqual(sequence, "\x1b_Ga=T,f=100,q=2,C=1,c=10,r=4,i=7;QUJD\x1b\\");
		});

		it("should wrap Kitty sequences for tmux passthrough", () => {
			const sequence = withTmuxEnv("/tmp/tmux,123,0", () => encodeKitty("QUJD", { columns: 10, rows: 4 }));
			assert.strictEqual(sequence, "\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,C=1,c=10,r=4;QUJD\x1b\x1b\\\x1b\\");
		});

		it("should wrap each Kitty chunk separately for tmux passthrough", () => {
			const payload = "A".repeat(5000);
			const sequence = withTmuxEnv("/tmp/tmux,123,0", () => encodeKitty(payload));
			assert.strictEqual(sequence.match(/\x1bPtmux;/g)?.length, 2);
			assert.strictEqual(sequence.match(/\x1b\\/g)?.length, 4);
			assert.ok(sequence.includes("\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,C=1,m=1;"));
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

	describe("Kitty Unicode placeholders (tmux)", () => {
		it("should produce upload APC + placeholder lines", () => {
			const result = withTmuxEnv("/tmp/tmux,1,0", () =>
				encodeKittyPlaceholder("QUJD", { columns: 3, rows: 2, imageId: 42 }),
			);
			// Upload sequence must be DCS-wrapped and contain U=1
			assert.ok(result.uploadSequence.startsWith("\x1bPtmux;"));
			assert.ok(result.uploadSequence.includes("U=1"));
			assert.ok(result.uploadSequence.includes("i=42"));
			// Should have one placeholder line per row
			assert.strictEqual(result.placeholderLines.length, 2);
		});

		it("should encode image ID as true-color foreground", () => {
			// Image ID 42: r=0, g=0, b=42
			const result = withTmuxEnv("/tmp/tmux,1,0", () =>
				encodeKittyPlaceholder("QUJD", { columns: 2, rows: 1, imageId: 42 }),
			);
			const line = result.placeholderLines[0]!;
			assert.ok(line.includes("\x1b[38;2;0;0;42m"));
			assert.ok(line.endsWith("\x1b[39m"));
		});

		it("should encode image ID with all three RGB components", () => {
			// ID 0x1A2B3C → r=0x1A=26, g=0x2B=43, b=0x3C=60
			const result = withTmuxEnv("/tmp/tmux,1,0", () =>
				encodeKittyPlaceholder("QUJD", { columns: 1, rows: 1, imageId: 0x1a2b3c }),
			);
			assert.ok(result.placeholderLines[0]!.includes("\x1b[38;2;26;43;60m"));
		});

		it("should contain U+10EEEE placeholder characters", () => {
			const result = withTmuxEnv("/tmp/tmux,1,0", () =>
				encodeKittyPlaceholder("QUJD", { columns: 4, rows: 1, imageId: 1 }),
			);
			const placeholder = String.fromCodePoint(0x10eeee);
			const line = result.placeholderLines[0]!;
			// First cell has diacritics, remaining are bare — total 4 occurrences
			const count = line.split(placeholder).length - 1;
			assert.strictEqual(count, 4);
		});

		it("isImageLine should detect placeholder lines", () => {
			const result = withTmuxEnv("/tmp/tmux,1,0", () =>
				encodeKittyPlaceholder("QUJD", { columns: 2, rows: 2, imageId: 5 }),
			);
			// Both the upload line and pure placeholder lines are image lines
			assert.strictEqual(isImageLine(result.uploadSequence + result.placeholderLines[0]!), true);
			assert.strictEqual(isImageLine(result.placeholderLines[1]!), true);
		});

		it("should chunk large payloads with DCS wrapping per chunk", () => {
			const bigPayload = "A".repeat(5000);
			const result = withTmuxEnv("/tmp/tmux,1,0", () =>
				encodeKittyPlaceholder(bigPayload, { columns: 2, rows: 1, imageId: 7 }),
			);
			// Two DCS-wrapped chunks (4096 + 904)
			assert.strictEqual(result.uploadSequence.match(/\x1bPtmux;/g)?.length, 2);
		});

		it("renderImage should return placeholderLines inside tmux", () => {
			withEnv("TERM_PROGRAM", "kitty", () =>
				withCapabilitiesReset(() => {
					const result = withTmuxEnv("/tmp/tmux,1,0", () =>
						renderImage(PNG_1X1_BASE64, { widthPx: 100, heightPx: 50 }, { maxWidthCells: 10, imageId: 99 }),
					);
					assert.ok(result);
					assert.ok(result.placeholderLines);
					assert.strictEqual(result.placeholderLines.length, result.rows);
				}),
			);
		});

		it("renderImage should NOT return placeholderLines outside tmux", () => {
			withEnv("TERM_PROGRAM", "kitty", () =>
				withCapabilitiesReset(() => {
					const result = withTmuxEnv(undefined, () =>
						renderImage(PNG_1X1_BASE64, { widthPx: 100, heightPx: 50 }, { maxWidthCells: 10, imageId: 99 }),
					);
					assert.ok(result);
					assert.strictEqual(result.placeholderLines, undefined);
				}),
			);
		});
	});

	describe("Image component", () => {
		it("should auto-allocate a stable Kitty image ID for PNG rerenders", () => {
			withEnv("TERM_PROGRAM", "kitty", () =>
				withCapabilitiesReset(() => {
					const image = new Image(
						PNG_1X1_BASE64,
						"image/png",
						{ fallbackColor: (s) => s },
						{ maxWidthCells: 10 },
						{ widthPx: 100, heightPx: 50 },
					);

					const firstLines = image.render(20);
					const firstImageId = image.getImageId();
					assert.ok(firstImageId);
					assert.ok(firstLines.at(-1)?.includes(`i=${firstImageId}`));

					image.invalidate();
					const secondLines = image.render(20);
					assert.strictEqual(image.getImageId(), firstImageId);
					assert.ok(secondLines.at(-1)?.includes(`i=${firstImageId}`));
				}),
			);
		});

		it("should reuse an explicitly provided Kitty image ID across rerenders", () => {
			withTmuxEnv(undefined, () =>
				withEnv("TERM_PROGRAM", "kitty", () =>
					withCapabilitiesReset(() => {
						const image = new Image(
							PNG_1X1_BASE64,
							"image/png",
							{ fallbackColor: (s) => s },
							{ maxWidthCells: 10, imageId: 7 },
							{ widthPx: 100, heightPx: 50 },
						);

						const firstLines = image.render(20);
						assert.strictEqual(image.getImageId(), 7);
						assert.ok(firstLines.at(-1)?.includes("i=7"));
						assert.ok(firstLines.at(-1)?.startsWith(`\x1b[${firstLines.length - 1}A`));
						assert.ok(firstLines.at(-1)?.endsWith(`\x1b[${firstLines.length - 1}B`));

						image.invalidate();
						const secondLines = image.render(20);
						assert.strictEqual(image.getImageId(), 7);
						assert.ok(secondLines.at(-1)?.includes("i=7"));
						assert.ok(secondLines.at(-1)?.endsWith(`\x1b[${secondLines.length - 1}B`));
					}),
				),
			);
		});

		it("should clamp very narrow Kitty widths to at least one column", () => {
			withEnv("TERM_PROGRAM", "kitty", () =>
				withCapabilitiesReset(() => {
					const image = new Image(PNG_1X1_BASE64, "image/png", { fallbackColor: (s) => s }, undefined, {
						widthPx: 100,
						heightPx: 50,
					});

					const lines = image.render(1);
					assert.ok(lines.at(-1)?.includes("c=1"));
					assert.ok(!lines.at(-1)?.includes("c=-"));
				}),
			);
		});

		it("should honor maxHeightCells by shrinking width when needed", () => {
			withEnv("TERM_PROGRAM", "kitty", () =>
				withCapabilitiesReset(() => {
					const image = new Image(
						PNG_1X1_BASE64,
						"image/png",
						{ fallbackColor: (s) => s },
						{ maxWidthCells: 60, maxHeightCells: 5, imageId: 9 },
						{ widthPx: 100, heightPx: 400 },
					);

					const lines = image.render(120);
					assert.strictEqual(lines.length <= 5, true);
					assert.ok(lines.at(-1)?.includes("c=2"));
					assert.ok(lines.at(-1)?.includes("r=5") || lines.at(-1)?.includes("r=4"));
					const result = renderImage(
						PNG_1X1_BASE64,
						{ widthPx: 100, heightPx: 400 },
						{ maxWidthCells: 60, maxHeightCells: 5, imageId: 9 },
					);
					assert.ok(result);
					assert.strictEqual(result.rows <= 5, true);
				}),
			);
		});

		it("should fall back for non-PNG Kitty images instead of emitting invalid Kitty payloads", () => {
			withEnv("TERM_PROGRAM", "kitty", () =>
				withCapabilitiesReset(() => {
					const image = new Image(
						"QUJD",
						"image/jpeg",
						{ fallbackColor: (s) => s },
						{ maxWidthCells: 10 },
						{ widthPx: 100, heightPx: 50 },
					);

					const lines = image.render(20);
					assert.strictEqual(image.getImageId(), undefined);
					assert.deepStrictEqual(lines, ["[Image: [image/jpeg] 100x50]"]);
					assert.strictEqual(renderImage("QUJD", { widthPx: 100, heightPx: 50 }, { maxWidthCells: 10 }), null);
				}),
			);
		});

		it("should not allocate Kitty image IDs for iTerm2 images", () => {
			withEnv("TERM_PROGRAM", "iterm.app", () =>
				withClearedKittyLikeEnv(() =>
					withCapabilitiesReset(() => {
						const image = new Image(
							PNG_1X1_BASE64,
							"image/png",
							{ fallbackColor: (s) => s },
							{ maxWidthCells: 10 },
							{ widthPx: 100, heightPx: 50 },
						);

						const firstLines = image.render(20);
						assert.strictEqual(image.getImageId(), undefined);
						assert.ok(firstLines.at(-1)?.includes("\x1b]1337;File="));
						assert.ok(!firstLines.at(-1)?.includes("i="));
						assert.ok(!/\x1b\[\d+B$/.test(firstLines.at(-1) ?? ""));

						image.invalidate();
						const secondLines = image.render(20);
						assert.strictEqual(image.getImageId(), undefined);
						assert.ok(secondLines.at(-1)?.includes("\x1b]1337;File="));
						assert.ok(!secondLines.at(-1)?.includes("i="));
					}),
				),
			);
		});

		it("should keep fallback behavior for terminals without image support", () => {
			withEnv("TERM_PROGRAM", "vscode", () =>
				withEnv("ITERM_SESSION_ID", undefined, () =>
					withClearedKittyLikeEnv(() =>
						withCapabilitiesReset(() => {
							const image = new Image(
								PNG_1X1_BASE64,
								"image/png",
								{ fallbackColor: (s) => s },
								{ maxWidthCells: 10 },
								{ widthPx: 100, heightPx: 50 },
							);

							const lines = image.render(20);
							assert.strictEqual(image.getImageId(), undefined);
							assert.deepStrictEqual(lines, ["[Image: [image/png] 100x50]"]);
						}),
					),
				),
			);
		});

		it("should emit placeholder lines instead of cursor movement in tmux", () => {
			withTmuxEnv("/tmp/tmux,1,0", () =>
				withEnv("TERM_PROGRAM", "kitty", () =>
					withCapabilitiesReset(() => {
						const image = new Image(
							PNG_1X1_BASE64,
							"image/png",
							{ fallbackColor: (s) => s },
							{ maxWidthCells: 10 },
							{ widthPx: 100, heightPx: 50 },
						);

						const lines = image.render(20);
						const placeholder = String.fromCodePoint(0x10eeee);
						// First line contains upload APC + placeholder text
						assert.ok(lines[0]!.includes("U=1"));
						assert.ok(lines[0]!.includes(placeholder));
						// No cursor-up/down escape sequences (direct mode artifact)
						for (const line of lines) {
							assert.ok(!line.endsWith("B"), "Should not end with cursor-down");
						}
						// All lines should contain placeholder chars
						// (first line has APC + placeholder, rest are pure placeholder)
						for (const line of lines) {
							assert.ok(line.includes(placeholder));
						}
					}),
				),
			);
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
