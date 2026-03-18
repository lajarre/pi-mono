import * as os from "node:os";
import {
	allocateImageId,
	Box,
	type Component,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	imageFallback,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.js";
import { computeEditDiff, type EditDiffError, type EditDiffResult } from "../../../core/tools/edit-diff.js";
import { allToolDefinitions, allTools } from "../../../core/tools/index.js";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../../core/tools/truncate.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { theme } from "../theme/theme.js";

export interface ToolExecutionOptions {
	showImages?: boolean;
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

type ConvertedImage = {
	sourceData: string;
	sourceMimeType: string;
	data: string;
	mimeType: string;
};

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	// Cached edit diff preview (computed when args arrive, before tool executes)
	private editDiffPreview?: EditDiffResult | EditDiffError;
	private editDiffArgsKey?: string; // Track which args the preview is for
	// Cached converted images for Kitty protocol (which requires PNG), keyed by image index and source payload.
	private convertedImages: Map<number, ConvertedImage> = new Map();
	// Stable Kitty image IDs keyed by result image index so rebuilds replace
	// the same image instead of stacking duplicate placements.
	private kittyImageIds: Map<number, number> = new Map();
	// Incremental syntax highlighting cache for write tool call args
	private writeHighlightCache?: WriteHighlightCache;
	// When true, this component intentionally renders no lines
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = allToolDefinitions[toolName as keyof typeof allToolDefinitions];
		this.showImages = options.showImages ?? true;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create both. contentBox is used for tools with renderer-based call/result composition.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));

		if (this.hasRendererDefinition()) {
			this.addChild(this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		for (const [index, converted] of this.convertedImages) {
			const img = imageBlocks[index];
			if (
				!img?.data ||
				!img?.mimeType ||
				img.data !== converted.sourceData ||
				img.mimeType !== converted.sourceMimeType
			) {
				this.convertedImages.delete(index);
			}
		}

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted for this exact source image
			if (img.mimeType === "image/png") continue;
			const cached = this.convertedImages.get(i);
			if (cached && cached.sourceData === img.data && cached.sourceMimeType === img.mimeType) continue;

			const index = i;
			const sourceData = img.data;
			const sourceMimeType = img.mimeType;

			// Mark as pending/cached to prevent concurrent conversions or infinite retry loops on failure
			this.convertedImages.set(index, {
				sourceData,
				sourceMimeType,
				data: sourceData,
				mimeType: sourceMimeType,
			});

			convertToPng(sourceData, sourceMimeType).then((converted) => {
				const currentImage = this.result?.content?.filter((c: any) => c.type === "image")?.[index] || undefined;
				if (!currentImage?.data || !currentImage?.mimeType) {
					return;
				}
				if (currentImage.data !== sourceData || currentImage.mimeType !== sourceMimeType) {
					return;
				}
				if (converted) {
					this.convertedImages.set(index, {
						sourceData,
						sourceMimeType,
						data: converted.data,
						mimeType: converted.mimeType,
					});
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	dispose(): void {
		this.kittyImageIds.clear();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				this.contentBox.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					this.contentBox.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					this.contentBox.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						this.contentBox.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						this.contentBox.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							this.contentBox.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			const activeKittyImageIndexes = new Set<number>();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (!caps.images || !this.showImages || !img.data || !img.mimeType) {
					continue;
				}

				// Use converted PNG for Kitty protocol if available for this exact source image.
				const cached = this.convertedImages.get(i);
				const converted =
					cached && cached.sourceData === img.data && cached.sourceMimeType === img.mimeType ? cached : undefined;
				const imageData = converted?.data ?? img.data;
				const imageMimeType = converted?.mimeType ?? img.mimeType;

				if (caps.images === "kitty" && imageMimeType !== "image/png") {
					continue;
				}

				let imageId: number | undefined;
				if (caps.images === "kitty" && process.env.PI_TMUX_IMAGES) {
					activeKittyImageIndexes.add(i);
					imageId = this.kittyImageIds.get(i);
					if (imageId === undefined) {
						imageId = allocateImageId();
						this.kittyImageIds.set(i, imageId);
					}
				}

				const spacer = new Spacer(1);
				this.addChild(spacer);
				this.imageSpacers.push(spacer);
				const imageComponent = new Image(
					imageData,
					imageMimeType,
					{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
					{ maxWidthCells: 60, imageId },
				);
				this.imageComponents.push(imageComponent);
				this.addChild(imageComponent);
			}

			if (caps.images === "kitty") {
				for (const index of [...this.kittyImageIds.keys()]) {
					if (activeKittyImageIndexes.has(index)) continue;
					this.kittyImageIds.delete(index);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
