import type { AssistantMessage } from "@mariozechner/pi-ai";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderLines(component: { render(width: number): string[] }): string[] {
	return component.render(120).map((line) => stripAnsi(line));
}

describe("message timestamps", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	describe("SettingsManager", () => {
		it("defaults showMessageTimestamps to false", () => {
			const manager = SettingsManager.inMemory({});
			expect(manager.getShowMessageTimestamps()).toBe(false);
		});

		it("loads and persists terminal.showMessageTimestamps", () => {
			const manager = SettingsManager.inMemory({
				terminal: { showMessageTimestamps: true },
			});
			expect(manager.getShowMessageTimestamps()).toBe(true);

			manager.setShowMessageTimestamps(false);
			expect(manager.getShowMessageTimestamps()).toBe(false);

			manager.setShowMessageTimestamps(true);
			expect(manager.getShowMessageTimestamps()).toBe(true);
		});
	});

	describe("interactive components", () => {
		const timestamp = new Date("2026-03-20T14:37:02.000Z").getTime();
		const expectedTime = new Date(timestamp).toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});

		it("renders user message timestamps in the existing top padding line", () => {
			const withTimestamp = new UserMessageComponent("bonjour", undefined, {
				timestamp,
				showTimestamp: true,
			});
			const withoutTimestamp = new UserMessageComponent("bonjour", undefined, {
				timestamp,
				showTimestamp: false,
			});

			const withLines = renderLines(withTimestamp);
			const withoutLines = renderLines(withoutTimestamp);
			expect(withLines).toHaveLength(withoutLines.length);
			expect(withLines[0]?.trim()).toBe(expectedTime);
			expect(withLines.slice(1).join("\n")).toContain("bonjour");
			expect(withoutLines[0]?.trim()).toBe("");
		});

		it("renders assistant message timestamps in the existing top padding line", () => {
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "salut" }],
				timestamp,
			} as AssistantMessage;
			const withTimestamp = new AssistantMessageComponent(message, false, undefined, true);
			const withoutTimestamp = new AssistantMessageComponent(message, false, undefined, false);

			const withLines = renderLines(withTimestamp);
			const withoutLines = renderLines(withoutTimestamp);
			expect(withLines).toHaveLength(withoutLines.length);
			expect(withLines[0]?.trim()).toBe(expectedTime);
			expect(withLines.slice(1).join("\n")).toContain("salut");
			expect(withoutLines[0]?.trim()).toBe("");
		});
	});
});
