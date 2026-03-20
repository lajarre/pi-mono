import { Container, Markdown, type MarkdownTheme, Spacer, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function formatTimestamp(timestamp?: number): string | null {
	if (!timestamp) {
		return null;
	}
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function renderRightAlignedTimestamp(width: number, timestamp: string): string {
	const rightText = truncateToWidth(theme.fg("dim", timestamp), width, "");
	const spacing = Math.max(0, width - visibleWidth(rightText));
	return " ".repeat(spacing) + rightText;
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private timestamp: string | null;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options?: { timestamp?: number; showTimestamp?: boolean },
	) {
		super();
		this.timestamp = options?.showTimestamp ? formatTimestamp(options.timestamp) : null;
		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(text, 1, 1, markdownTheme, {
				bgColor: (text: string) => theme.bg("userMessageBg", text),
				color: (text: string) => theme.fg("userMessageText", text),
			}),
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = this.timestamp ? renderRightAlignedTimestamp(width, this.timestamp) : lines[0];
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
		return lines;
	}
}
