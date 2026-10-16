import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	generateDiffString,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { colorToHex, getKeybindings } from "@earendil-works/pi-tui";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MODULES = join(ROOT, "node_modules");

// Page files and vendor assets, keyed by URL path. Served before the token check.
const STATIC_FILES: Record<string, string> = {
	"/vendor/markdown-it.js": join(MODULES, "markdown-it", "dist", "browser", "markdown-it.umd.min.js"),
	"/vendor/footnote.js": join(MODULES, "markdown-it-footnote", "dist", "markdown-it-footnote.min.js"),
	"/vendor/tasklists.js": join(MODULES, "markdown-it-task-lists", "dist", "markdown-it-task-lists.min.js"),
	"/vendor/texmath.js": join(MODULES, "markdown-it-texmath", "texmath.js"),
	"/vendor/hljs.js": join(MODULES, "@highlightjs", "cdn-assets", "highlight.min.js"),
	"/vendor/hljs.css": join(MODULES, "@highlightjs", "cdn-assets", "styles", "github-dark.min.css"),
	"/vendor/hljs-light.css": join(MODULES, "@highlightjs", "cdn-assets", "styles", "github.min.css"),
	"/vendor/mermaid.js": join(MODULES, "mermaid", "dist", "mermaid.min.js"),
	"/vendor/ansi_up.js": join(MODULES, "ansi_up", "ansi_up.js"),
	"/icon.svg": join(ROOT, "icon.svg"),
	"/common.js": join(ROOT, "common.js"),
	"/common.css": join(ROOT, "common.css"),
};
const KATEX_DIR = join(MODULES, "katex", "dist");
const APP_PAGE = join(ROOT, "app.html");
const MIME: Record<string, string> = {
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".html": "text/html; charset=utf-8",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
};
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
const IMAGE_MIME: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};
// Same temp-file name Pi uses for a clipboard image. Display only; the message text is unchanged.
const CLIPBOARD_IMAGE =
	/pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp|bmp)/gi;
const MAX_LOCAL_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_TOOL_TEXT = 6000;
const MAX_DIFF_LINES = 400;
const THEME_POLL_MS = 1000;
const EDITOR_POLL_MS = 100;
const MAX_EDITOR_TEXT = 200_000;
const DIFF_CONTEXT_LINES = 2;
// Pi theme tokens the page uses; everything else keeps the page's own neutral palette.
const THEME_TOKENS = [
	"accent", "text", "muted", "error", "warning", "success", "mdLink", "thinkingText",
	"userMessageBg", "userMessageText", "toolDiffAdded", "toolDiffRemoved", "bashMode",
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax",
] as const;
const MAX_FILES = 20000;
const FILE_CACHE_MS = 15000;
const IGNORED_DIRS = new Set([
	"node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
	".venv", "venv", "__pycache__", ".next", ".cache", ".turbo",
]);
// Hidden command used to run session-control actions with an ExtensionCommandContext.
const ACTION_COMMAND = "gui-action";
const MAX_WIDGET_LINES = 10;
// Width used to render component widgets for the page.
const COMPONENT_WIDTH = 100;
const COMPONENT_REFRESH_MS = 1000;

/* ---------- Process-wide host ---------- */

// The HTTP server outlives extension instances so the page stays connected across
// /reload, /new, /resume and /fork; each new instance re-binds the request handler.
interface Host {
	token: string;
	server?: Server;
	baseUrl?: string;
	heartbeat?: ReturnType<typeof setInterval>;
	clients: Set<ServerResponse>;
	handler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
	// Chrome window pinned by the title-bar button. Survives page reloads in the same process.
	topmostHwnd?: string;
	// Last Chrome window we put in the foreground, and the helper that does it.
	focusHwnd?: string;
	focusHelper?: ChildProcess;
	focusStdout?: string;
	focusWaiters?: Array<{ settled?: boolean; resolve: (hwnd: string) => void }>;
}
const HOST_KEY = Symbol.for("pi-twebui.host");
const globals = globalThis as typeof globalThis & { [HOST_KEY]?: Host };
const host: Host = (globals[HOST_KEY] ??= { token: randomBytes(24).toString("hex"), clients: new Set() });

/* ---------- Transcript views ---------- */

type Part =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

interface LooseMessage {
	role: string;
	content?: string | Part[];
	toolCallId?: string;
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	details?: { diff?: unknown };
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
}

interface LooseEntry {
	type: string;
	id: string;
	message?: LooseMessage;
	summary?: string;
	display?: boolean;
	customType?: string;
	content?: string | Part[];
}

interface DiffLine {
	kind: "add" | "del" | "ctx" | "gap";
	num: string;
	text: string;
}

interface DiffView {
	path: string;
	lines: DiffLine[];
	added: number;
	removed: number;
	truncated: boolean;
}

interface ThreadTool {
	id: string;
	name: string;
	summary: string;
	args: string;
	result?: string;
	isError?: boolean;
	diff?: DiffView;
}

// Raw call arguments, kept out of the JSON sent to the page.
const rawToolArgs = new WeakMap<ThreadTool, Record<string, unknown>>();

interface AssistantItem {
	kind: "assistant";
	id: string;
	key: string;
	text: string;
	thinking: string;
	tools: ThreadTool[];
	error?: string;
	aborted: boolean;
}

type ThreadItem =
	| AssistantItem
	| { kind: "user"; id: string; key: string; text: string; images: { data: string; mimeType: string }[]; imagePaths: string[] }
	| { kind: "bash"; id: string; key: string; command: string; output: string; exitCode: number | null; cancelled: boolean }
	| { kind: "compaction" | "branchSummary"; id: string; key: string; text: string }
	| { kind: "custom"; id: string; key: string; title: string; text: string };

const truncate = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
// Streaming output is most useful at its end.
const truncateTail = (text: string, max: number) =>
	text.length > max ? `… (${text.length - max} earlier characters)\n${text.slice(-max)}` : text;

const partsOf = (holder: { content?: string | Part[] }): Part[] =>
	typeof holder.content === "string" ? [{ type: "text", text: holder.content }] : (holder.content ?? []);

const textOf = (parts: Part[]) =>
	parts
		.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
		.map((p) => p.text)
		.join("\n")
		.trim();

// One-line description of a tool call, preferring the argument people recognise it by.
function toolSummary(args: Record<string, unknown>): string {
	for (const key of ["command", "path", "pattern", "query", "url", "subject", "code"]) {
		const value = args[key];
		if (typeof value === "string" && value) return value.split("\n")[0];
	}
	const first = Object.values(args).find((v): v is string => typeof v === "string" && v.length > 0);
	return first?.split("\n")[0] ?? "";
}

function assistantItem(id: string, msg: LooseMessage): AssistantItem {
	const parts = partsOf(msg);
	return {
		kind: "assistant",
		id,
		key: id,
		text: textOf(parts),
		thinking: parts
			.filter((p): p is Extract<Part, { type: "thinking" }> => p.type === "thinking")
			.map((p) => p.thinking)
			.join("\n")
			.trim(),
		tools: parts
			.filter((p): p is Extract<Part, { type: "toolCall" }> => p.type === "toolCall")
			.map((p) => {
				const args = p.arguments ?? {};
				const tool: ThreadTool = {
					id: p.id,
					name: p.name,
					summary: truncate(toolSummary(args), 200),
					args: truncate(JSON.stringify(args, null, 2), MAX_TOOL_TEXT),
					diff: toolDiff(p.name, args, undefined),
				};
				rawToolArgs.set(tool, args);
				return tool;
			}),
		error: msg.stopReason === "error" ? msg.errorMessage : undefined,
		aborted: msg.stopReason === "aborted",
	};
}

/* ---------- Diffs for file-changing tools ---------- */

// Parses Pi's display diff ("+12 text", "-12 text", " 12 text", "    ...").
function parsePiDiff(diff: string, withNumbers: boolean): DiffLine[] {
	return diff.split("\n").map((line) => {
		const match = /^([+\- ])(\s*\d*)\s(.*)$/.exec(line);
		if (!match) return { kind: "gap", num: "", text: line.trim() };
		const kind = match[1] === "+" ? "add" : match[1] === "-" ? "del" : "ctx";
		return { kind, num: withNumbers ? match[2].trim() : "", text: match[3] };
	});
}

// Pi's edit tool accepts edits as an array, a single object, a JSON string, or legacy oldText/newText.
function editsOf(args: Record<string, unknown>): { oldText: string; newText: string }[] {
	let edits: unknown = args.edits;
	if (typeof edits === "string") {
		// Streaming arguments can hold an incomplete JSON string; there is nothing to show yet.
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = [];
		}
	}
	const list = (Array.isArray(edits) ? edits : edits ? [edits] : []) as Record<string, unknown>[];
	if (typeof args.oldText === "string" && typeof args.newText === "string") list.push({ oldText: args.oldText, newText: args.newText });
	return list.filter((e): e is { oldText: string; newText: string } => typeof e?.oldText === "string" && typeof e?.newText === "string");
}

function toolDiff(name: string, args: Record<string, unknown>, details: LooseMessage["details"]): DiffView | undefined {
	let lines: DiffLine[];
	if (name === "edit") {
		lines =
			typeof details?.diff === "string"
				? parsePiDiff(details.diff, true)
				: // Before the result arrives, diff each replacement on its own; file line numbers are not known yet.
					editsOf(args).flatMap((edit, i) => [
						...(i > 0 ? [{ kind: "gap" as const, num: "", text: "..." }] : []),
						...parsePiDiff(generateDiffString(edit.oldText, edit.newText, DIFF_CONTEXT_LINES).diff, false),
					]);
	} else if (name === "write" && typeof args.content === "string") {
		lines = args.content.split("\n").map((text, i) => ({ kind: "add", num: String(i + 1), text }));
	} else {
		return undefined;
	}
	if (lines.length === 0) return undefined;
	return {
		path: typeof args.path === "string" ? args.path : "",
		lines: lines.slice(0, MAX_DIFF_LINES),
		added: lines.filter((l) => l.kind === "add").length,
		removed: lines.filter((l) => l.kind === "del").length,
		truncated: lines.length > MAX_DIFF_LINES,
	};
}

// A pasted image is a temp-file path inside the user text, the same way the terminal stores it.
// The page shows that file; nothing here is added to the message.
function pastedImagePaths(text: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	CLIPBOARD_IMAGE.lastIndex = 0;
	for (const match of text.matchAll(CLIPBOARD_IMAGE)) {
		const name = match[0];
		const head = text.slice(0, match.index ?? 0);
		const win = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]*\\)*$/.exec(head);
		const nix = /(?:^|[\s"'`])(\/(?:[^/\s"'`]+\/)*)$/.exec(head);
		const fromText = win ? `${win[0]}${name}` : nix?.[1] ? `${nix[1]}${name}` : "";
		const candidate = fromText && existsSync(fromText) ? fromText : join(tmpdir(), name);
		const file = resolve(candidate);
		if (seen.has(file) || !existsSync(file)) continue;
		seen.add(file);
		paths.push(file);
	}
	return paths;
}

function getThread(ctx: ExtensionContext): ThreadItem[] {
	const items: ThreadItem[] = [];
	const toolsById = new Map<string, ThreadTool>();
	for (const raw of ctx.sessionManager.getBranch()) {
		const entry = raw as unknown as LooseEntry;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			const kind = entry.type === "compaction" ? "compaction" : "branchSummary";
			items.push({ kind, id: entry.id, key: entry.id, text: entry.summary ?? "" });
			continue;
		}
		if (entry.type === "custom_message") {
			if (entry.display) {
				items.push({ kind: "custom", id: entry.id, key: entry.id, title: entry.customType ?? "", text: textOf(partsOf(entry)) });
			}
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		if (msg.role === "user") {
			const parts = partsOf(msg);
			const text = textOf(parts);
			const images = parts.filter((p): p is Extract<Part, { type: "image" }> => p.type === "image");
			items.push({
				kind: "user",
				id: entry.id,
				key: entry.id,
				text,
				images: images.map(({ data, mimeType }) => ({ data, mimeType })),
				imagePaths: pastedImagePaths(text),
			});
		} else if (msg.role === "assistant") {
			const item = assistantItem(entry.id, msg);
			for (const tool of item.tools) toolsById.set(tool.id, tool);
			if (item.text || item.thinking || item.tools.length || item.error || item.aborted) items.push(item);
		} else if (msg.role === "toolResult" && msg.toolCallId) {
			const tool = toolsById.get(msg.toolCallId);
			if (!tool) continue;
			tool.result = truncate(textOf(partsOf(msg)), MAX_TOOL_TEXT);
			tool.isError = msg.isError === true;
			// The edit tool reports the applied diff with real file line numbers.
			if (!tool.isError) tool.diff = toolDiff(tool.name, rawToolArgs.get(tool) ?? {}, msg.details);
		} else if (msg.role === "bashExecution") {
			items.push({
				kind: "bash",
				id: entry.id,
				key: entry.id,
				command: msg.command ?? "",
				output: truncateTail(msg.output ?? "", MAX_TOOL_TEXT),
				exitCode: msg.exitCode ?? null,
				cancelled: msg.cancelled === true,
			});
		}
	}
	// Tool results arrive after their call, so the key changes when an assistant item gains results.
	for (const item of items) {
		if (item.kind === "assistant") item.key = `${item.id}:${item.tools.filter((t) => t.result !== undefined).length}`;
	}
	return items;
}

interface TreeRow {
	id: string;
	depth: number;
	// Same labels as Pi's /tree rows.
	kind: "user" | "assistant" | "tool" | "bash" | "compaction" | "branchSummary" | "custom";
	text: string;
	label?: string;
	onPath: boolean;
}

// Pi's tree selector shortens tool calls to "[read: path]" style lines.
function formatToolCall(name: string, args: Record<string, unknown>): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const shorten = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
	const path = (fallback = "") => shorten(String(args.path || args.file_path || fallback));
	switch (name) {
		case "read": {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let display = path();
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				display += `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}`;
			}
			return `[read: ${display}]`;
		}
		case "write":
		case "edit":
			return `[${name}: ${path()}]`;
		case "bash": {
			const raw = String(args.command || "");
			return `[bash: ${raw.replace(/[\n\t]/g, " ").trim().slice(0, 50)}${raw.length > 50 ? "..." : ""}]`;
		}
		case "grep":
			return `[grep: /${String(args.pattern || "")}/ in ${shorten(String(args.path || "."))}]`;
		case "find":
			return `[find: ${String(args.pattern || "")} in ${shorten(String(args.path || "."))}]`;
		case "ls":
			return `[ls: ${shorten(String(args.path || "."))}]`;
		default: {
			const json = JSON.stringify(args);
			return `[${name}: ${json.slice(0, 40)}${json.length > 40 ? "..." : ""}]`;
		}
	}
}

// Flatten the session tree like Pi's /tree: same rows, same filtering, indentation only grows at branch points.
function getTree(ctx: ExtensionContext): TreeRow[] {
	const onPath = new Set(ctx.sessionManager.getBranch().map((e) => e.id));
	const leafId = ctx.sessionManager.getLeafId();
	const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	for (const raw of ctx.sessionManager.getEntries()) {
		const entry = raw as unknown as LooseEntry;
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const part of partsOf(entry.message)) {
			if (part.type === "toolCall") toolCalls.set(part.id, { name: part.name, arguments: part.arguments });
		}
	}
	const oneLine = (text: string) => text.replace(/[\n\t]/g, " ").trim();
	const rows: TreeRow[] = [];
	const stack = ctx.sessionManager
		.getTree()
		.map((node) => ({ node, depth: 0 }))
		.reverse();
	while (stack.length) {
		const { node, depth } = stack.pop()!;
		const entry = node.entry as unknown as LooseEntry;
		const message = entry.message;
		let row: Pick<TreeRow, "kind" | "text"> | undefined;
		if (entry.type === "message" && message) {
			if (message.role === "user") {
				row = { kind: "user", text: oneLine(textOf(partsOf(message))) };
			} else if (message.role === "assistant") {
				const text = oneLine(textOf(partsOf(message)));
				const failed = message.stopReason && message.stopReason !== "stop" && message.stopReason !== "toolUse";
				// Tool-call-only assistant messages are hidden unless they are the current leaf or failed.
				if (text) row = { kind: "assistant", text };
				else if (message.stopReason === "aborted") row = { kind: "assistant", text: "(aborted)" };
				else if (message.errorMessage) row = { kind: "assistant", text: oneLine(message.errorMessage).slice(0, 80) };
				else if (failed || entry.id === leafId) row = { kind: "assistant", text: "(no content)" };
			} else if (message.role === "toolResult") {
				const call = message.toolCallId ? toolCalls.get(message.toolCallId) : undefined;
				row = { kind: "tool", text: call ? formatToolCall(call.name, call.arguments) : `[${(message as { toolName?: string }).toolName ?? "tool"}]` };
			} else if (message.role === "bashExecution") {
				row = { kind: "bash", text: `[bash]: ${oneLine(message.command ?? "")}` };
			}
		} else if (entry.type === "custom_message") {
			row = { kind: "custom", text: `[${entry.customType}]: ${oneLine(typeof entry.content === "string" ? entry.content : textOf(partsOf(entry as { content?: Part[] })))}` };
		} else if (entry.type === "compaction") {
			row = { kind: "compaction", text: `[compaction: ${Math.round(((entry as { tokensBefore?: number }).tokensBefore ?? 0) / 1000)}k tokens]` };
		} else if (entry.type === "branch_summary") {
			row = { kind: "branchSummary", text: `[branch summary]: ${oneLine(entry.summary ?? "")}` };
		}
		if (row) {
			rows.push({ ...row, text: row.text.slice(0, 200), id: entry.id, depth, label: node.label, onPath: onPath.has(entry.id) });
		}
		const childDepth = node.children.length > 1 ? depth + 1 : depth;
		for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: childDepth });
	}
	return rows;
}
let fileCache: { root: string; at: number; files: string[] } | undefined;

async function listFiles(root: string): Promise<string[]> {
	if (fileCache && fileCache.root === root && Date.now() - fileCache.at < FILE_CACHE_MS) return fileCache.files;
	const files: string[] = [];
	const pending = [""];
	while (pending.length && files.length < MAX_FILES) {
		const rel = pending.pop()!;
		// Unreadable directories (permissions, races) are simply not listed.
		const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				files.push(`${path}/`);
				pending.push(path);
			} else {
				files.push(path);
			}
		}
	}
	fileCache = { root, at: Date.now(), files };
	return files;
}

async function searchFiles(root: string, query: string): Promise<string[]> {
	const q = query.toLowerCase().replace(/\\/g, "/");
	const scored: { path: string; score: number }[] = [];
	for (const path of await listFiles(root)) {
		const lower = path.toLowerCase();
		const base = lower.replace(/\/$/, "").split("/").pop()!;
		const score = !q ? lower.split("/").length : base.startsWith(q) ? 0 : base.includes(q) ? 1 : lower.includes(q) ? 2 : -1;
		if (score >= 0) scored.push({ path, score });
	}
	scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
	return scored.slice(0, 30).map((s) => s.path);
}

// Pi's footer shows the working directory relative to the home directory as ~.
function homeRelative(cwd: string): string {
	const rel = relative(homedir(), resolve(cwd));
	if (rel === "") return "~";
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? cwd : `~${sep}${rel}`;
}

/* ---------- HTTP helpers ---------- */

// Windows opens a chrome --app window (no tabs or address bar), so the page sees more shortcuts.
function openUrl(url: string) {
	const [cmd, args] =
		process.platform === "win32"
			? ["cmd", ["/c", "start", "", "chrome", `--app=${url}`]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
}

// The page cannot change OS window z-order. PowerShell calls SetWindowPos on the Chrome window.
function applyWindowTopmost(title: string, enabled: boolean, pageHost: string, savedHwnd: string | undefined): Promise<string> {
	if (process.platform !== "win32") return Promise.reject(new Error("Always on top is only available on Windows"));
	const payload = JSON.stringify({ title, enabled, host: pageHost, hwnd: savedHwnd ?? "" });
	return new Promise((resolve, reject) => {
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "topmost.ps1")],
			{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_TOPMOST_JSON: payload } },
		);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Timed out while updating the window"));
		}, 8000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				const hwnd = stdout.trim();
				if (!/^-?\d+$/.test(hwnd)) reject(new Error("Unexpected window handle"));
				else resolve(hwnd);
				return;
			}
			const errors: Record<number, string> = {
				2: "Could not find the Pi TWebui window. Focus it and try again.",
				3: "More than one window has this title. Focus the Pi TWebui window and try again.",
				4: "Windows could not change the window z-order.",
			};
			reject(new Error(errors[code ?? 0] ?? (stderr.trim() || "Could not change the window z-order")));
		});
	});
}

// A long-lived PowerShell so putting the window back in front does not pay process startup.
// Listeners stay on the process across /reload; the host object is process-wide.
function ensureFocusHelper() {
	if (process.platform !== "win32") return;
	const current = host.focusHelper;
	if (current && current.exitCode === null && !current.killed) return;
	const child = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "focus-window.ps1")],
		{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
	);
	host.focusHelper = child;
	host.focusStdout = "";
	host.focusWaiters = [];
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		if (host.focusHelper !== child) return;
		host.focusStdout = (host.focusStdout ?? "") + chunk;
		let nl = host.focusStdout.indexOf("\n");
		while (nl >= 0) {
			const line = host.focusStdout.slice(0, nl).trim();
			host.focusStdout = host.focusStdout.slice(nl + 1);
			nl = host.focusStdout.indexOf("\n");
			if (!line) continue;
			const waiter = host.focusWaiters?.shift();
			if (!waiter || waiter.settled) continue;
			waiter.settled = true;
			waiter.resolve(line.startsWith("ok ") ? line.slice(3).trim() : "");
		}
	});
	child.on("exit", () => {
		if (host.focusHelper !== child) return;
		host.focusHelper = undefined;
		const waiters = host.focusWaiters ?? [];
		host.focusWaiters = [];
		for (const waiter of waiters) {
			if (waiter.settled) continue;
			waiter.settled = true;
			waiter.resolve("");
		}
	});
}

function focusPageWindow(title: string, pageHost: string): Promise<string> {
	if (process.platform !== "win32") return Promise.resolve("");
	ensureFocusHelper();
	const child = host.focusHelper;
	if (!child?.stdin) return Promise.resolve("");
	return new Promise((resolve) => {
		const waiters = (host.focusWaiters ??= []);
		const waiter = {
			settled: false,
			resolve: (hwnd: string) => {
				clearTimeout(timer);
				if (/^\d+$/.test(hwnd)) host.focusHwnd = hwnd;
				resolve(hwnd);
			},
		};
		const timer = setTimeout(() => {
			if (waiter.settled) return;
			waiter.settled = true;
			resolve("");
		}, 4000);
		waiters.push(waiter);
		child.stdin.write(
			`${JSON.stringify({
				title: Buffer.from(title, "utf8").toString("base64"),
				host: pageHost,
				hwnd: host.focusHwnd ?? host.topmostHwnd ?? "",
			})}\n`,
		);
	});
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(value ?? {}));
}

async function sendFile(res: ServerResponse, path: string) {
	const data = await readFile(path);
	res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
	res.end(data);
}

// Only image files already named in this session's user messages. The bytes are not part of the prompt.
function sendLocalImage(current: ExtensionContext, res: ServerResponse, rawPath: string) {
	const file = resolve(rawPath);
	const mime = IMAGE_MIME[extname(file).toLowerCase()];
	const allowed = Boolean(mime) && getThread(current).some((item) => item.kind === "user" && item.imagePaths.includes(file));
	if (!allowed) return sendJson(res, 404, { error: "Not found" });
	const stat = statSync(file);
	if (!stat.isFile() || stat.size > MAX_LOCAL_IMAGE_BYTES) return sendJson(res, 404, { error: "Not found" });
	res.writeHead(200, {
		"content-type": mime,
		"content-length": stat.size,
		"cache-control": "private, max-age=86400",
	});
	createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

function broadcast(event: Record<string, unknown>) {
	const frame = `data: ${JSON.stringify(event)}\n\n`;
	for (const client of host.clients) client.write(frame);
}

async function ensureServer(): Promise<string> {
	if (host.baseUrl) return host.baseUrl;
	const server = createServer((req, res) => {
		const handler = host.handler;
		if (!handler) return sendJson(res, 503, { error: "Pi is switching sessions" });
		handler(req, res).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (res.headersSent) res.end();
			else sendJson(res, 500, { error: message });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	host.server = server;
	host.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	host.heartbeat = setInterval(() => {
		for (const client of host.clients) client.write(": ping\n\n");
	}, 15000);
	host.heartbeat.unref();
	return host.baseUrl;
}

function closeServer() {
	for (const client of host.clients) client.end();
	host.clients.clear();
	clearInterval(host.heartbeat);
	host.server?.close();
	host.server?.closeAllConnections();
	host.server = undefined;
	host.baseUrl = undefined;
	host.focusHelper?.kill();
	host.focusHelper = undefined;
}

/* ---------- Requests from the page ---------- */

interface SubmitBody {
	text: string;
	deliverAs: "steer" | "followUp";
}

type ActionBody =
	| { type: "abort" | "newSession" | "clone" | "reload" | "quit" | "cycleThinking" }
	| { type: "cycleModel"; direction: "forward" | "backward" }
	| { type: "setModel"; provider: string; id: string }
	| { type: "setThinking"; level: Parameters<ExtensionAPI["setThinkingLevel"]>[0] }
	| { type: "compact"; instructions: string }
	| { type: "rename"; name: string }
	| { type: "fork"; entryId: string }
	| { type: "navigate"; entryId: string; summarize: boolean }
	| { type: "resume"; path: string };

interface CommandJob {
	run: (cmd: ExtensionCommandContext) => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

/* ---------- Mirroring ctx.ui to the page ---------- */

type UI = ExtensionContext["ui"];
type Placement = "aboveEditor" | "belowEditor";
interface RenderableComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
}
interface Widget {
	placement: Placement;
	lines?: string[];
	component?: RenderableComponent;
}
type DialogSpec =
	| { kind: "select"; title: string; options: string[] }
	| { kind: "confirm"; title: string; message: string }
	| { kind: "input"; title: string; placeholder: string }
	| { kind: "editor"; title: string; prefill: string };
interface Dialog {
	id: string;
	spec: DialogSpec;
	deadline?: number;
	answer: (value: unknown) => void;
}

// Mirror of what extensions show through ctx.ui. The terminal keeps its own rendering;
// the page gets the same widgets, statuses, notifications and dialogs.
class UIMirror {
	readonly widgets = new Map<string, Widget>();
	readonly statuses = new Map<string, string>();
	readonly dialogs = new Map<string, Dialog>();
	title = "";
	workingMessage = "";
	// Extension footer/header replacing Pi's built-in ones (setFooter/setHeader), shared with the terminal.
	private footer?: RenderableComponent;
	private header?: RenderableComponent;
	workingVisible = true;
	private componentTimer?: ReturnType<typeof setInterval>;
	private lastFrame = "";
	private customView?: RenderableComponent;
	private customTimer?: ReturnType<typeof setInterval>;
	private lastCustom = "";

	constructor(private readonly onChange: (event: Record<string, unknown>) => void) {}

	// Wraps the terminal UI object in place: the extension runner hands this same object
	// to every extension, so later ctx.ui calls from any extension pass through here.
	install(ui: UI) {
		const original = { ...ui } as UI;
		const target = ui as unknown as Record<string, unknown>;

		target.setWidget = (key: string, content: unknown, options?: { placement?: Placement }) => {
			const placement = options?.placement ?? "aboveEditor";
			if (typeof content !== "function") {
				(original.setWidget as (k: string, c: unknown, o?: unknown) => void)(key, content, options);
				this.setWidget(key, content === undefined ? undefined : { placement, lines: (content as string[]).slice(0, MAX_WIDGET_LINES) });
				return;
			}
			// Capture the component the terminal creates from the factory so both sides share one instance.
			const factory = content as (...args: unknown[]) => RenderableComponent;
			let component: RenderableComponent | undefined;
			const capturing = (...args: unknown[]) => (component = factory(...args));
			(original.setWidget as (k: string, c: unknown, o?: unknown) => void)(key, capturing, options);
			this.setWidget(key, { placement, component });
		};
		target.setFooter = (factory: ((...args: unknown[]) => RenderableComponent) | undefined) => {
			this.footer = undefined;
			const capturing = factory && ((...args: unknown[]) => (this.footer = factory(...args)));
			(original.setFooter as (f: unknown) => void)(capturing);
			this.syncTimer();
			this.emitChrome();
		};
		target.setHeader = (factory: ((...args: unknown[]) => RenderableComponent) | undefined) => {
			this.header = undefined;
			const capturing = factory && ((...args: unknown[]) => (this.header = factory(...args)));
			(original.setHeader as (f: unknown) => void)(capturing);
			this.syncTimer();
			this.emitChrome();
		};
		target.setWorkingVisible = (visible: boolean) => {
			original.setWorkingVisible(visible);
			this.workingVisible = visible;
			this.emitChrome();
		};
		target.setStatus = (key: string, text: string | undefined) => {
			original.setStatus(key, text);
			if (text === undefined) this.statuses.delete(key);
			else this.statuses.set(key, text);
			this.emitChrome();
		};
		target.notify = (message: string, type?: "info" | "warning" | "error") => {
			original.notify(message, type);
			this.onChange({ type: "notify", message, level: type ?? "info" });
		};
		target.setTitle = (title: string) => {
			original.setTitle(title);
			this.title = title;
			this.emitChrome();
		};
		target.setWorkingMessage = (message?: string) => {
			original.setWorkingMessage(message);
			this.workingMessage = message ?? "";
			this.emitChrome();
		};
		// setEditorText changes the buffer without asking the terminal to draw. A no-op status
		// update is the public call that does request a redraw, and it stays off the page.
		target.setEditorText = (text: string) => {
			original.setEditorText(text);
			original.setStatus("pi-twebui-sync", undefined);
		};
		target.select = (title: string, options: string[], opts?: DialogOpts) =>
			this.race({ kind: "select", title, options }, opts, (o) => original.select(title, options, o));
		target.confirm = (title: string, message: string, opts?: DialogOpts) =>
			this.race({ kind: "confirm", title, message }, opts, (o) => original.confirm(title, message, o));
		target.input = (title: string, placeholder?: string, opts?: DialogOpts) =>
			this.race({ kind: "input", title, placeholder: placeholder ?? "" }, opts, (o) => original.input(title, placeholder, o));
		// Pi's terminal editor dialog cannot be closed from outside, so the page only shows it.
		target.editor = (title: string, prefill?: string) =>
			this.track({ kind: "editor", title, prefill: prefill ?? "" }, original.editor(title, prefill));
		// /mcp and other terminal screens. The terminal still owns the component; the page
		// renders the same instance and forwards keys into it. Nothing is added to the prompt.
		target.custom = ((factory, options) => {
			const wrapped: typeof factory = (tui, theme, keybindings, done) => {
				const created = factory(tui, theme, keybindings, (result) => {
					this.clearCustom();
					done(result);
				});
				const attach = (component: RenderableComponent | undefined) => {
					if (!component || typeof component.render !== "function") return;
					this.customView = component;
					if (!this.customTimer) {
						this.customTimer = setInterval(() => this.emitCustom(), 100);
						this.customTimer.unref();
					}
					this.emitCustom(true);
				};
				if (created && typeof (created as Promise<RenderableComponent>).then === "function") {
					void Promise.resolve(created as Promise<RenderableComponent>).then(attach);
				} else {
					attach(created as RenderableComponent);
				}
				return created;
			};
			return Promise.resolve(original.custom(wrapped, options)).finally(() => this.clearCustom());
		}) as UI["custom"];
	}

	private setWidget(key: string, widget: Widget | undefined) {
		if (widget) this.widgets.set(key, widget);
		else this.widgets.delete(key);
		this.syncTimer();
		this.emitChrome();
	}

	// Components change without notifying anyone, so re-render them periodically.
	private syncTimer() {
		const needed = !!this.footer || !!this.header || [...this.widgets.values()].some((w) => w.component);
		if (needed && !this.componentTimer) {
			this.componentTimer = setInterval(() => this.emitChrome(true), COMPONENT_REFRESH_MS);
			this.componentTimer.unref();
		} else if (!needed && this.componentTimer) {
			clearInterval(this.componentTimer);
			this.componentTimer = undefined;
		}
	}

	// Terminal and page answer the same dialog; whichever answers first wins and the other closes.
	private async race<T>(spec: DialogSpec, opts: DialogOpts | undefined, runTerminal: (opts: DialogOpts) => Promise<T>): Promise<T> {
		const id = randomBytes(8).toString("hex");
		const terminalAbort = new AbortController();
		const signal = opts?.signal ? AbortSignal.any([terminalAbort.signal, opts.signal]) : terminalAbort.signal;
		const page = new Promise<T>((resolve) => {
			this.dialogs.set(id, {
				id,
				spec,
				deadline: opts?.timeout ? Date.now() + opts.timeout : undefined,
				answer: (value) => resolve(value as T),
			});
		});
		this.emitDialogs();
		try {
			const result = await Promise.race([runTerminal({ ...opts, signal }), page]);
			terminalAbort.abort();
			return result;
		} finally {
			this.dialogs.delete(id);
			this.emitDialogs();
		}
	}

	private async track<T>(spec: DialogSpec, terminal: Promise<T>): Promise<T> {
		const id = randomBytes(8).toString("hex");
		this.dialogs.set(id, { id, spec, answer: () => {} });
		this.emitDialogs();
		try {
			return await terminal;
		} finally {
			this.dialogs.delete(id);
			this.emitDialogs();
		}
	}

	answer(id: string, value: unknown) {
		const dialog = this.dialogs.get(id);
		if (!dialog) throw new Error("This dialog was already answered");
		if (dialog.spec.kind === "editor") throw new Error("This dialog can only be completed in the terminal");
		dialog.answer(value);
	}

	chrome() {
		return {
			widgets: [...this.widgets.entries()].map(([key, w]) => ({
				key,
				placement: w.placement,
				lines: w.lines ?? w.component?.render(COMPONENT_WIDTH).slice(0, MAX_WIDGET_LINES * 3) ?? [],
			})),
			// Sorted by key like Pi's footer.
			statuses: [...this.statuses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, text]) => ({ key, text })),
			customFooter: this.footer?.render(COMPONENT_WIDTH).slice(0, MAX_WIDGET_LINES) ?? null,
			customHeader: this.header?.render(COMPONENT_WIDTH).slice(0, MAX_WIDGET_LINES * 3) ?? null,
			workingVisible: this.workingVisible,
			title: this.title,
			workingMessage: this.workingMessage,
		};
	}

	dialogList() {
		return [...this.dialogs.values()].map(({ id, spec, deadline }) => ({ id, ...spec, deadline }));
	}

	customSnapshot() {
		if (!this.customView) return { open: false, lines: [] as string[] };
		let lines: string[] = [];
		try {
			lines = this.customView.render(COMPONENT_WIDTH).slice(0, 80);
		} catch {
			lines = [];
		}
		return { open: true, lines };
	}

	sendCustomKey(data: string) {
		if (!this.customView?.handleInput) throw new Error("No custom UI is open");
		if (data.length === 0 || data.length > 8000) throw new Error("Invalid key");
		this.customView.handleInput(data);
		this.emitCustom(true);
	}

	private clearCustom() {
		if (!this.customView && !this.customTimer) return;
		this.customView = undefined;
		clearInterval(this.customTimer);
		this.customTimer = undefined;
		this.emitCustom(true);
	}

	private emitCustom(force = false) {
		const snap = this.customSnapshot();
		const frame = JSON.stringify(snap);
		if (!force && frame === this.lastCustom) return;
		this.lastCustom = frame;
		this.onChange({ type: "custom-ui", ...snap });
	}

	private emitChrome(onlyIfChanged = false) {
		const chrome = this.chrome();
		const frame = JSON.stringify(chrome);
		if (onlyIfChanged && frame === this.lastFrame) return;
		this.lastFrame = frame;
		this.onChange({ type: "chrome", chrome });
	}

	private emitDialogs() {
		this.onChange({ type: "dialogs", dialogs: this.dialogList() });
	}

	dispose() {
		clearInterval(this.componentTimer);
		this.clearCustom();
		for (const dialog of this.dialogs.values()) dialog.answer(undefined);
	}
}

type DialogOpts = { signal?: AbortSignal; timeout?: number };

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let mirror: UIMirror | undefined;
	const jobs: CommandJob[] = [];

	function requireCtx(): ExtensionContext {
		if (!ctx) throw new Error("No active Pi session");
		return ctx;
	}
	function requireMirror(): UIMirror {
		if (!mirror) throw new Error("No active Pi session");
		return mirror;
	}

	// Session replacement and tree navigation only exist on command contexts, so route
	// them through a command dispatched like a typed slash command.
	function runCommand(run: CommandJob["run"]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			jobs.push({ run, resolve, reject });
			pi.sendUserMessage(`/${ACTION_COMMAND}`, { expandPromptTemplates: true });
		});
	}

	// Same totals as Pi's footer: assistant, tool-result and summary usage, plus the latest cache hit rate.
	function usageTotals(current: ExtensionContext) {
		const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		let cacheHitRate: number | null = null;
		for (const raw of current.sessionManager.getEntries()) {
			const entry = raw as unknown as LooseEntry & { usage?: LooseMessage["usage"] };
			const message = entry.type === "message" ? entry.message : undefined;
			const usage =
				message?.role === "assistant" || message?.role === "toolResult"
					? message.usage
					: entry.type === "compaction" || entry.type === "branch_summary"
						? entry.usage
						: undefined;
			if (!usage) continue;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost.total;
			if (message?.role === "assistant") {
				const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
				cacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : null;
			}
		}
		return { totals, cacheHitRate };
	}

	// Long-running session work Pi shows in its status row instead of the working spinner.
	let activity: { kind: "compaction" | "branchSummary"; reason?: string } | null = null;

	// Pi's pending-messages area lists queued steering/follow-up input. Queued input arrives as
	// input events with a streaming behavior; each delivery starts a user message (steering first).
	const queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };

	let themeTimer: ReturnType<typeof setInterval> | undefined;
	let lastTheme = "";
	// Pi has no editor-change event. Poll the terminal editor and skip echoes of page writes.
	let editorTimer: ReturnType<typeof setInterval> | undefined;
	let editorShown = "";
	let editorFromPage: string | undefined;

	function editorTextOf(current: ExtensionContext): string {
		return current.ui.getEditorText();
	}

	function watchEditor(current: ExtensionContext) {
		editorShown = editorTextOf(current);
		editorFromPage = undefined;
		clearInterval(editorTimer);
		editorTimer = setInterval(() => {
			if (!ctx || host.clients.size === 0) return;
			const text = editorTextOf(ctx);
			if (text === editorShown) return;
			if (editorFromPage !== undefined && text === editorFromPage) {
				editorShown = text;
				editorFromPage = undefined;
				return;
			}
			editorFromPage = undefined;
			editorShown = text;
			broadcast({ type: "editor", text });
		}, EDITOR_POLL_MS);
		editorTimer.unref();
	}

	function setEditorFromPage(current: ExtensionContext, text: string): string {
		if (typeof text !== "string") throw new Error("Missing editor text");
		if (text.length > MAX_EDITOR_TEXT) throw new Error("Editor text is too long");
		const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
		if (editorTextOf(current) !== normalized) current.ui.setEditorText(normalized);
		const actual = editorTextOf(current);
		editorFromPage = actual;
		editorShown = actual;
		return actual;
	}

	let gitBranch: string | null = null;
	async function refreshGitBranch(current: ExtensionContext) {
		const result = await pi.exec("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: current.cwd, timeout: 3000 });
		const branch = result.code === 0 ? result.stdout.trim() || null : null;
		if (branch === gitBranch) return;
		gitBranch = branch;
		pushState();
	}

	// Pi's active terminal theme, as CSS colors for the page.
	function themeColors(current: ExtensionContext) {
		const theme = current.ui.theme;
		const colors = theme.colors;
		return {
			appearance: theme.appearance,
			colors: Object.fromEntries(THEME_TOKENS.map((token) => [token, colorToHex(colors[token])])),
		};
	}

	function getState(current: ExtensionContext) {
		const { totals, cacheHitRate } = usageTotals(current);
		const model = current.model;
		return {
			idle: current.isIdle(),
			pending: current.hasPendingMessages(),
			cwd: current.cwd,
			cwdDisplay: homeRelative(current.cwd),
			sessionName: pi.getSessionName() ?? "",
			sessionFile: current.sessionManager.getSessionFile() ?? "",
			sessionId: current.sessionManager.getSessionId(),
			entries: current.sessionManager.getEntries().length,
			model: model
				? { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow }
				: null,
			thinkingLevel: pi.getThinkingLevel(),
			thinkingLevels: model ? getSupportedThinkingLevels(model) : [],
			context: current.getContextUsage() ?? null,
			theme: themeColors(current),
			totals,
			cacheHitRate,
			activity,
			queue,
			gitBranch,
			autoCompact: pi.getSettings().compaction?.enabled ?? true,
			hideThinking: pi.getSettings().hideThinkingBlock ?? false,
			providerCount: new Set(current.modelRegistry.getAvailable().map((m) => m.provider)).size,
			editorText: current.ui.getEditorText(),
		};
	}

	let stateTimer: ReturnType<typeof setTimeout> | undefined;
	function pushState() {
		if (stateTimer) return;
		stateTimer = setTimeout(() => {
			stateTimer = undefined;
			if (ctx) broadcast({ type: "state", state: getState(ctx) });
		}, 50);
	}

	let liveTimer: ReturnType<typeof setTimeout> | undefined;
	let liveMessage: LooseMessage | undefined;
	function pushLive(message: LooseMessage) {
		liveMessage = message;
		if (liveTimer) return;
		liveTimer = setTimeout(() => {
			liveTimer = undefined;
			if (liveMessage) broadcast({ type: "live", item: assistantItem("live", liveMessage) });
		}, 80);
	}
	function endLive() {
		clearTimeout(liveTimer);
		liveTimer = undefined;
		liveMessage = undefined;
		broadcast({ type: "live-end" });
	}

	const toolTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const toolOutput = new Map<string, string>();
	function pushToolOutput(id: string, output: string) {
		toolOutput.set(id, output);
		if (toolTimers.has(id)) return;
		toolTimers.set(
			id,
			setTimeout(() => {
				toolTimers.delete(id);
				broadcast({ type: "tool", id, running: true, output: toolOutput.get(id) ?? "" });
			}, 100),
		);
	}
	function endTool(id: string) {
		clearTimeout(toolTimers.get(id));
		toolTimers.delete(id);
		toolOutput.delete(id);
		broadcast({ type: "tool", id, running: false, output: "" });
	}

	function submit(current: ExtensionContext, body: SubmitBody) {
		if (!body.text) throw new Error("Nothing to send");
		// Match the terminal editor: slash commands, skills and prompt templates expand.
		if (current.isIdle()) pi.sendUserMessage(body.text, { expandPromptTemplates: true });
		else pi.sendUserMessage(body.text, { deliverAs: body.deliverAs, expandPromptTemplates: true });
		current.ui.setEditorText("");
	}

	async function runAction(current: ExtensionContext, body: ActionBody): Promise<unknown> {
		switch (body.type) {
			case "abort":
				current.abort();
				return {};
			case "setModel": {
				const model = current.modelRegistry.find(body.provider, body.id);
				if (!model) throw new Error(`Unknown model ${body.provider}/${body.id}`);
				if (!(await pi.setModel(model))) throw new Error(`No credentials configured for ${model.provider}`);
				return {};
			}
			case "setThinking":
				pi.setThinkingLevel(body.level);
				return {};
			// Same cycling as the terminal's Shift+Tab: through the levels the current model supports.
			case "cycleThinking": {
				const model = current.model;
				if (!model?.reasoning) throw new Error("Current model does not support thinking");
				const levels = getSupportedThinkingLevels(model);
				const next = levels[(levels.indexOf(pi.getThinkingLevel()) + 1) % levels.length];
				pi.setThinkingLevel(next);
				return { level: next };
			}
			// Same cycling as the terminal's Ctrl+P: scoped models when configured, otherwise all available.
			case "cycleModel": {
				const available = current.modelRegistry.getAvailable();
				const availableIds = new Set(available.map((m) => `${m.provider}/${m.id}`));
				const scoped = current.scopedModels.map((s) => s.model).filter((m) => availableIds.has(`${m.provider}/${m.id}`));
				const pool = scoped.length ? scoped : available;
				if (pool.length <= 1) throw new Error(scoped.length ? "Only one model in scope" : "Only one model available");
				const at = pool.findIndex((m) => m.provider === current.model?.provider && m.id === current.model?.id);
				const step = body.direction === "backward" ? pool.length - 1 : 1;
				const next = pool[(Math.max(at, 0) + step) % pool.length];
				if (!(await pi.setModel(next))) throw new Error(`No credentials configured for ${next.provider}`);
				return { name: next.name || next.id };
			}
			case "compact":
				current.compact({
					customInstructions: body.instructions || undefined,
					onComplete: () => broadcast({ type: "compact", ok: true }),
					onError: (error) => broadcast({ type: "compact", ok: false, error: error.message }),
				});
				return {};
			case "rename":
				pi.setSessionName(body.name);
				return {};
			case "newSession":
				return runCommand((cmd) => cmd.newSession());
			case "clone": {
				const leafId = current.sessionManager.getLeafId();
				if (!leafId) throw new Error("Nothing to clone yet");
				return runCommand((cmd) => cmd.fork(leafId, { position: "at" }));
			}
			case "fork":
				return runCommand((cmd) => cmd.fork(body.entryId));
			case "navigate":
				return runCommand((cmd) => cmd.navigateTree(body.entryId, { summarize: body.summarize }));
			case "resume":
				return runCommand((cmd) => cmd.switchSession(body.path));
			case "reload":
				return runCommand((cmd) => cmd.reload());
			case "quit":
				current.shutdown();
				return {};
			default:
				throw new Error(`Unknown action ${(body as { type: string }).type}`);
		}
	}

	async function getSessions(current: ExtensionContext, scope: string | null) {
		const list =
			scope === "all"
				? await SessionManager.listAll()
				: await SessionManager.list(current.cwd, current.sessionManager.getSessionDir());
		const currentFile = current.sessionManager.getSessionFile();
		return list
			.sort((a, b) => b.modified.getTime() - a.modified.getTime())
			.slice(0, 300)
			.map((s) => ({
				path: s.path,
				title: (s.name || s.firstMessage || "(empty)").replace(/\s+/g, " ").slice(0, 120),
				cwd: s.cwd,
				modified: s.modified.toISOString(),
				messageCount: s.messageCount,
				current: s.path === currentFile,
			}));
	}

	function getModels(current: ExtensionContext) {
		const scoped = new Set(current.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`));
		return current.modelRegistry.getAvailable().map((m) => ({
			provider: m.provider,
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			contextWindow: m.contextWindow,
			scoped: scoped.has(`${m.provider}/${m.id}`),
		}));
	}

	function openEvents(req: IncomingMessage, res: ServerResponse) {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
		res.write("retry: 1000\n\n");
		host.clients.add(res);
		req.on("close", () => host.clients.delete(res));
	}

	async function handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;

		const file = STATIC_FILES[path];
		if (file) return sendFile(res, file);
		if (path.startsWith("/vendor/katex/")) {
			const katexFile = normalize(join(KATEX_DIR, path.slice("/vendor/katex/".length)));
			if (!katexFile.startsWith(KATEX_DIR + sep)) return sendJson(res, 404, { error: "Not found" });
			return sendFile(res, katexFile);
		}

		if (url.searchParams.get("token") !== host.token && req.headers["x-token"] !== host.token) {
			return sendJson(res, 403, { error: "Invalid token" });
		}
		if (path === "/app") return sendFile(res, APP_PAGE);
		if (path === "/api/events") return openEvents(req, res);
		if (path === "/api/local-image" && req.method === "GET") {
			return sendLocalImage(requireCtx(), res, url.searchParams.get("path") ?? "");
		}
		if (path === "/api/always-on-top" && req.method === "POST") {
			if (process.platform !== "win32") return sendJson(res, 501, { error: "Always on top is only available on Windows" });
			const body = await readJson<{ enabled?: boolean; title?: string; host?: string }>(req);
			const title = typeof body.title === "string" ? body.title.trim() : "";
			if (!title || title.length > 500) return sendJson(res, 400, { error: "Missing window title" });
			const pageHost = typeof body.host === "string" && /^[a-z0-9.:-]+:\d+$/i.test(body.host) ? body.host : "";
			const enabled = body.enabled === true;
			const hwnd = await applyWindowTopmost(title, enabled, pageHost, host.topmostHwnd);
			host.topmostHwnd = enabled ? hwnd : undefined;
			return sendJson(res, 200, { on: enabled });
		}
		if (path === "/api/custom-key" && req.method === "POST") {
			const body = await readJson<{ data?: string }>(req);
			requireMirror().sendCustomKey(typeof body.data === "string" ? body.data : "");
			return sendJson(res, 200, {});
		}
		if (path === "/api/focus-window" && req.method === "POST") {
			if (process.platform !== "win32") return sendJson(res, 200, { ok: false });
			const body = await readJson<{ title?: string; host?: string }>(req);
			const title = typeof body.title === "string" ? body.title.trim() : "";
			if (!title || title.length > 500) return sendJson(res, 400, { error: "Missing window title" });
			const pageHost = typeof body.host === "string" && /^[a-z0-9.:-]+:\d+$/i.test(body.host) ? body.host : "";
			const hwnd = await focusPageWindow(title, pageHost);
			return sendJson(res, 200, { ok: hwnd.length > 0 });
		}

		const current = requireCtx();
		if (req.method === "POST") {
			if (path === "/api/submit") {
				submit(current, await readJson<SubmitBody>(req));
				return sendJson(res, 200, {});
			}
			if (path === "/api/editor") {
				const body = await readJson<{ text?: string }>(req);
				return sendJson(res, 200, { text: setEditorFromPage(current, body.text ?? "") });
			}
			// Like Pi's Ctrl+V: a pasted image becomes a temp file and its path goes into the editor text.
			if (path === "/api/paste-image") {
				const body = await readJson<{ data: string; mimeType: string }>(req);
				const ext = IMAGE_EXTENSIONS[body.mimeType];
				if (!ext) return sendJson(res, 400, { error: `Unsupported image type: ${body.mimeType}` });
				const file = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext}`);
				await writeFile(file, Buffer.from(body.data, "base64"));
				return sendJson(res, 200, { path: file });
			}
			if (path === "/api/action") return sendJson(res, 200, await runAction(current, await readJson<ActionBody>(req)));
			if (path === "/api/dialog") {
				const body = await readJson<{ id: string; value: unknown }>(req);
				requireMirror().answer(body.id, body.value);
				return sendJson(res, 200, {});
			}
			return sendJson(res, 404, { error: "Not found" });
		}
		switch (path) {
			case "/api/state":
				return sendJson(res, 200, getState(current));
			case "/api/ui":
				return sendJson(res, 200, {
				chrome: requireMirror().chrome(),
				dialogs: requireMirror().dialogList(),
				custom: requireMirror().customSnapshot(),
			});
			case "/api/thread":
				return sendJson(res, 200, getThread(current));
			case "/api/tree":
				return sendJson(res, 200, getTree(current));
			case "/api/sessions":
				return sendJson(res, 200, await getSessions(current, url.searchParams.get("scope")));
			case "/api/models":
				return sendJson(res, 200, getModels(current));
			// Pi's effective keybindings (defaults plus keybindings.json), so the page uses the same keys.
			case "/api/keys": {
				const keys = getKeybindings();
				const ids = [
					"app.interrupt", "app.thinking.cycle", "app.model.cycleForward", "app.model.cycleBackward", "app.model.select", "app.message.copy",
					"app.tools.expand", "app.thinking.toggle", "app.message.followUp", "app.message.dequeue",
					"app.session.new", "app.session.tree", "app.session.fork", "app.session.resume",
					"tui.altScreen.previousPrompt", "tui.altScreen.nextPrompt",
				] as const;
				return sendJson(res, 200, Object.fromEntries(ids.map((id) => [id, keys.getKeys(id)])));
			}
			case "/api/commands":
				return sendJson(
					res,
					200,
					pi
						.getCommands()
						.filter((c) => c.name !== ACTION_COMMAND && c.name !== "gui")
						.map(({ name, description, source }) => ({ name, description: description ?? "", source })),
				);
			case "/api/files":
				return sendJson(res, 200, await searchFiles(current.cwd, url.searchParams.get("q") ?? ""));
			default:
				return sendJson(res, 404, { error: "Not found" });
		}
	}

	async function openGui(current: ExtensionContext) {
		if (!current.hasUI) return;
		const url = `${await ensureServer()}/app?${new URLSearchParams({ token: host.token })}`;
		openUrl(url);
		current.ui.notify(`Pi TWebui: ${url}`, "info");
	}

	pi.on("session_start", async (event, current) => {
		ctx = current;
		// Each session runtime gets a fresh UI object from the runner; mirror it for the page.
		mirror = new UIMirror(broadcast);
		if (current.mode === "tui") mirror.install(current.ui);
		void refreshGitBranch(current);
		// Pi has no extension event for theme changes (/settings, ctx.ui.setTheme, theme file edits).
		clearInterval(themeTimer);
		lastTheme = JSON.stringify(themeColors(current));
		themeTimer = setInterval(() => {
			if (!ctx) return;
			const theme = JSON.stringify(themeColors(ctx));
			if (theme === lastTheme) return;
			lastTheme = theme;
			pushState();
		}, THEME_POLL_MS);
		themeTimer.unref();
		watchEditor(current);
		activity = null;
		queue.steering.length = 0;
		queue.followUp.length = 0;
		host.handler = handle;
		ensureFocusHelper();
		// /reload may have changed the page files too: tell open pages to reload themselves.
		broadcast({ type: "session", reload: event.reason === "reload" });
	});
	pi.on("session_shutdown", async (event) => {
		ctx = undefined;
		clearInterval(themeTimer);
		clearInterval(editorTimer);
		mirror?.dispose();
		mirror = undefined;
		if (host.handler === handle) host.handler = undefined;
		if (event.reason === "quit") return closeServer();
		broadcast({ type: "switching" });
	});

	pi.on("agent_start", async () => pushState());
	pi.on("agent_end", async () => pushState());
	pi.on("agent_settled", async (_event, current) => {
		// Abort and dequeue clear Pi's queue without an event; it is always empty once a run has settled.
		queue.steering.length = 0;
		queue.followUp.length = 0;
		pushState();
		// Tools may switch branches, so re-read it when a run settles.
		void refreshGitBranch(current);
	});
	pi.on("session_before_compact", async (event) => {
		activity = { kind: "compaction", reason: event.reason };
		pushState();
	});
	pi.on("session_compact_failed", async () => {
		activity = null;
		pushState();
	});
	pi.on("session_before_tree", async (event) => {
		if (!event.preparation.userWantsSummary) return;
		activity = { kind: "branchSummary" };
		pushState();
	});
	pi.on("input", async (event) => {
		if (!event.streamingBehavior) return;
		const text = event.text.trim() || (event.images?.length ? "(image)" : "");
		queue[event.streamingBehavior === "steer" ? "steering" : "followUp"].push(text);
		pushState();
	});
	// Pi removes a queued entry when a user message with the same text starts, steering first.
	pi.on("message_start", async (event) => {
		if (event.message.role !== "user") return;
		const text = textOf(partsOf(event.message as unknown as LooseMessage)) || "(image)";
		for (const list of [queue.steering, queue.followUp]) {
			const index = list.indexOf(text);
			if (index === -1) continue;
			list.splice(index, 1);
			pushState();
			return;
		}
	});
	pi.on("turn_end", async () => pushState());
	pi.on("model_select", async () => pushState());
	pi.on("thinking_level_select", async () => pushState());
	pi.on("session_info_changed", async () => pushState());
	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant") pushLive(event.message as unknown as LooseMessage);
	});
	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") endLive();
		broadcast({ type: "thread" });
		pushState();
	});
	pi.on("tool_execution_start", async (event) => broadcast({ type: "tool", id: event.toolCallId, running: true, output: "" }));
	pi.on("tool_execution_update", async (event) => {
		const partial = event.partialResult as { content?: Part[] } | undefined;
		pushToolOutput(event.toolCallId, truncateTail(textOf(partsOf(partial ?? {})), MAX_TOOL_TEXT));
	});
	pi.on("tool_execution_end", async (event) => endTool(event.toolCallId));
	pi.on("session_compact", async () => {
		activity = null;
		broadcast({ type: "thread" });
		pushState();
	});
	pi.on("session_tree", async () => {
		activity = null;
		broadcast({ type: "thread" });
		pushState();
	});
	// Mirrored dialogs appear on the page directly; only custom() terminal UIs need a hint.
	pi.on("ui_prompt_start", async (event) => {
		if (event.kind === "custom") broadcast({ type: "ui-prompt", active: true });
	});
	pi.on("ui_prompt_end", async (event) => {
		if (event.kind === "custom") broadcast({ type: "ui-prompt", active: false });
	});

	pi.registerCommand(ACTION_COMMAND, {
		description: "Internal: runs a pending Pi TWebui action",
		handler: async (_args, cmd) => {
			const job = jobs.shift();
			if (!job) return;
			try {
				job.resolve((await job.run(cmd)) ?? {});
			} catch (error) {
				job.reject(error);
			}
		},
	});
	const openDescription = "Open Pi TWebui for this session in the browser";
	pi.registerCommand("gui", {
		description: openDescription,
		handler: async (_args, current) => openGui(current),
	});
	pi.registerShortcut("alt+g", {
		description: openDescription,
		handler: async (current) => openGui(current),
	});
}
