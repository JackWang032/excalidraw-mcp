import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod/v4";
import type { CheckpointStore } from "./checkpoint-store.js";

/** Maximum allowed size for element/data input strings (5 MB). */
const MAX_INPUT_BYTES = 5 * 1024 * 1024;

// Works both from source (src/server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "..", "dist")
  : import.meta.dirname;

// ============================================================
// MCP to Native Excalidraw Format Converter
// ============================================================

let seedCounter = 1000;
let versionCounter = 1;

function getNextSeed(): number {
  return seedCounter++;
}

function getNextVersion(): number {
  return versionCounter++;
}

function estimateTextWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * 0.55);
}

function estimateTextHeight(fontSize: number): number {
  return Math.ceil(fontSize * 1.25);
}

/**
 * Convert MCP simplified format to native Excalidraw format.
 * - Transforms `label` property on shapes/arrows to bound text elements
 * - Adds all required fields for text elements to render correctly
 */
function convertMcpToNative(data: { elements?: any[] }): any[] {
  const elements = data.elements || [];
  const newElements: any[] = [];

  for (const el of elements) {
    // Skip pseudo-elements
    if (el.type === "cameraUpdate" || el.type === "restoreCheckpoint" || el.type === "delete") {
      continue;
    }

    // Convert element to native format
    const nativeEl = convertElementToNative(el);

    // Handle label property - convert to bound text element
    if (el.label && typeof el.label === "object") {
      const labelTextId = `${el.id}_label`;
      const labelText = el.label.text || "";
      const fontSize = el.label.fontSize || 16;

      if (el.type === "arrow") {
        // Arrow label: position at midpoint
        const midX = el.x + (el.width || 0) / 2;
        const midY = el.y + (el.height || 0) / 2;
        const labelElement = createStandaloneTextElement(
          labelTextId,
          labelText,
          fontSize,
          midX,
          midY
        );
        nativeEl.boundElements = nativeEl.boundElements || [];
        nativeEl.boundElements.push({ id: labelTextId, type: "text" });
        newElements.push(nativeEl);
        newElements.push(labelElement);
      } else if (["rectangle", "ellipse", "diamond"].includes(el.type)) {
        // Shape label: create bound text element centered in container
        const labelElement = createBoundTextElement(
          labelTextId,
          labelText,
          fontSize,
          nativeEl.x,
          nativeEl.y,
          nativeEl.width,
          nativeEl.height,
          el.id
        );
        nativeEl.boundElements = nativeEl.boundElements || [];
        nativeEl.boundElements.push({ id: labelTextId, type: "text" });
        newElements.push(nativeEl);
        newElements.push(labelElement);
      } else {
        newElements.push(nativeEl);
      }
    } else {
      newElements.push(nativeEl);
    }
  }

  return newElements;
}

function convertElementToNative(el: any): any {
  const native = { ...el };
  
  // Remove label property (handled separately)
  delete native.label;
  
  // Add required fields for all elements
  native.version = native.version || getNextVersion();
  native.versionNonce = native.versionNonce || getNextSeed();
  native.isDeleted = native.isDeleted || false;
  native.seed = native.seed || getNextSeed();
  native.groupIds = native.groupIds || [];
  native.frameId = native.frameId || null;
  native.angle = native.angle || 0;
  native.link = native.link || null;
  native.locked = native.locked || false;
  native.updated = native.updated || Date.now();
  
  if (el.type === "text") {
    native.fillStyle = native.fillStyle || "solid";
    native.strokeWidth = native.strokeWidth || 2;
    native.strokeStyle = native.strokeStyle || "solid";
    native.roughness = native.roughness || 1;
    native.opacity = native.opacity || 100;
    native.backgroundColor = native.backgroundColor || "transparent";
    native.roundness = native.roundness || null;
    native.boundElements = native.boundElements || null;
    native.rawText = native.rawText || native.text;
    native.originalText = native.originalText || native.text;
    native.fontFamily = native.fontFamily || 1;
    native.textAlign = native.textAlign || "left";
    native.verticalAlign = native.verticalAlign || "top";
    native.containerId = native.containerId || null;
    native.autoResize = native.autoResize !== false;
    native.lineHeight = native.lineHeight || 1.25;
    native.width = native.width || estimateTextWidth(native.text || "", native.fontSize || 20);
    native.height = native.height || estimateTextHeight(native.fontSize || 20);
  } else if (["rectangle", "ellipse", "diamond"].includes(el.type)) {
    native.fillStyle = native.fillStyle || "solid";
    native.strokeWidth = native.strokeWidth || 2;
    native.strokeStyle = native.strokeStyle || "solid";
    native.roughness = native.roughness || 1;
    native.opacity = native.opacity || 100;
    native.boundElements = native.boundElements || null;
  } else if (el.type === "arrow") {
    native.fillStyle = native.fillStyle || "solid";
    native.strokeWidth = native.strokeWidth || 2;
    native.strokeStyle = native.strokeStyle || "solid";
    native.roughness = native.roughness || 1;
    native.opacity = native.opacity || 100;
    native.boundElements = native.boundElements || null;
    native.startBinding = native.startBinding || null;
    native.endBinding = native.endBinding || null;
    native.startArrowhead = native.startArrowhead || null;
    native.endArrowhead = native.endArrowhead || "arrow";
  } else if (el.type === "line") {
    native.fillStyle = native.fillStyle || "solid";
    native.strokeWidth = native.strokeWidth || 2;
    native.strokeStyle = native.strokeStyle || "solid";
    native.roughness = native.roughness || 1;
    native.opacity = native.opacity || 100;
    native.boundElements = native.boundElements || null;
  }
  
  return native;
}

function createBoundTextElement(
  id: string,
  text: string,
  fontSize: number,
  containerX: number,
  containerY: number,
  containerWidth: number,
  containerHeight: number,
  containerId: string
): any {
  const textWidth = estimateTextWidth(text, fontSize);
  const textHeight = estimateTextHeight(fontSize);
  const x = containerX + (containerWidth - textWidth) / 2;
  const y = containerY + (containerHeight - textHeight) / 2;

  return {
    type: "text",
    version: getNextVersion(),
    versionNonce: getNextSeed(),
    isDeleted: false,
    id: id,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: x,
    y: y,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    width: textWidth,
    height: textHeight,
    seed: getNextSeed(),
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    text: text,
    rawText: text,
    fontSize: fontSize,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: containerId,
    originalText: text,
    autoResize: true,
    lineHeight: 1.25
  };
}

function createStandaloneTextElement(
  id: string,
  text: string,
  fontSize: number,
  centerX: number,
  centerY: number
): any {
  const textWidth = estimateTextWidth(text, fontSize);
  const textHeight = estimateTextHeight(fontSize);

  return {
    type: "text",
    version: getNextVersion(),
    versionNonce: getNextSeed(),
    isDeleted: false,
    id: id,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    angle: 0,
    x: centerX - textWidth / 2,
    y: centerY - textHeight / 2,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    width: textWidth,
    height: textHeight,
    seed: getNextSeed(),
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    text: text,
    rawText: text,
    fontSize: fontSize,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: null,
    originalText: text,
    autoResize: true,
    lineHeight: 1.25
  };
}

// ============================================================
// RECALL: shared knowledge for the agent
// ============================================================
const RECALL_CHEAT_SHEET = `# Excalidraw Element Format

Thanks for calling read_me! Do NOT call it again in this conversation — you will not see anything new. Now use create_view to draw.

## Color Palette (use consistently across all tools)

### Primary Colors
| Name | Hex | Use |
|------|-----|-----|
| Blue | \`#4a9eed\` | Primary actions, links, data series 1 |
| Amber | \`#f59e0b\` | Warnings, highlights, data series 2 |
| Green | \`#22c55e\` | Success, positive, data series 3 |
| Red | \`#ef4444\` | Errors, negative, data series 4 |
| Purple | \`#8b5cf6\` | Accents, special items, data series 5 |
| Pink | \`#ec4899\` | Decorative, data series 6 |
| Cyan | \`#06b6d4\` | Info, secondary, data series 7 |
| Lime | \`#84cc16\` | Extra, data series 8 |

### Excalidraw Fills (pastel, for shape backgrounds)
| Color | Hex | Good For |
|-------|-----|----------|
| Light Blue | \`#a5d8ff\` | Input, sources, primary nodes |
| Light Green | \`#b2f2bb\` | Success, output, completed |
| Light Orange | \`#ffd8a8\` | Warning, pending, external |
| Light Purple | \`#d0bfff\` | Processing, middleware, special |
| Light Red | \`#ffc9c9\` | Error, critical, alerts |
| Light Yellow | \`#fff3bf\` | Notes, decisions, planning |
| Light Teal | \`#c3fae8\` | Storage, data, memory |
| Light Pink | \`#eebefa\` | Analytics, metrics |

### Background Zones (use with opacity: 30 for layered diagrams)
| Color | Hex | Good For |
|-------|-----|----------|
| Blue zone | \`#dbe4ff\` | UI / frontend layer |
| Purple zone | \`#e5dbff\` | Logic / agent layer |
| Green zone | \`#d3f9d8\` | Data / tool layer |

---

## Excalidraw Elements

### Required Fields (all elements)
\`type\`, \`id\` (unique string), \`x\`, \`y\`, \`width\`, \`height\`

### Defaults (skip these)
strokeColor="#1e1e1e", backgroundColor="transparent", fillStyle="solid", strokeWidth=2, roughness=1, opacity=100
Canvas background is white.

### Element Types

**Rectangle**: \`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 100 }\`
- \`roundness: { type: 3 }\` for rounded corners
- \`backgroundColor: "#a5d8ff"\`, \`fillStyle: "solid"\` for filled

**Ellipse**: \`{ "type": "ellipse", "id": "e1", "x": 100, "y": 100, "width": 150, "height": 150 }\`

**Diamond**: \`{ "type": "diamond", "id": "d1", "x": 100, "y": 100, "width": 150, "height": 150 }\`

**Labeled shape (PREFERRED)**: Add \`label\` to any shape for auto-centered text. No separate text element needed.
\`{ "type": "rectangle", "id": "r1", "x": 100, "y": 100, "width": 200, "height": 80, "label": { "text": "Hello", "fontSize": 20 } }\`
- Works on rectangle, ellipse, diamond
- Text auto-centers and container auto-resizes to fit
- Saves tokens vs separate text elements

**Labeled arrow**: \`"label": { "text": "connects" }\` on an arrow element.

**Standalone text** (titles, annotations only):
\`{ "type": "text", "id": "t1", "x": 150, "y": 138, "text": "Hello", "fontSize": 20 }\`
- x is the LEFT edge of the text. To center text at position cx: set x = cx - estimatedWidth/2
- estimatedWidth ≈ text.length × fontSize × 0.5
- Do NOT rely on textAlign or width for positioning — they only affect multi-line wrapping

**Arrow**: \`{ "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 200, "height": 0, "points": [[0,0],[200,0]], "endArrowhead": "arrow" }\`
- points: [dx, dy] offsets from element x,y
- endArrowhead: null | "arrow" | "bar" | "dot" | "triangle"

### Arrow Bindings
Arrow: \`"startBinding": { "elementId": "r1", "fixedPoint": [1, 0.5] }\`
fixedPoint: top=[0.5,0], bottom=[0.5,1], left=[0,0.5], right=[1,0.5]

**cameraUpdate** (pseudo-element — controls the viewport, not drawn):
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\`
- x, y: top-left corner of the visible area (scene coordinates)
- width, height: size of the visible area — MUST be 4:3 ratio (400×300, 600×450, 800×600, 1200×900, 1600×1200)
- Animates smoothly between positions — use multiple cameraUpdates to guide attention as you draw
- No \`id\` needed — this is not a drawn element

**delete** (pseudo-element — removes elements by id):
\`{ "type": "delete", "ids": "b2,a1,t3" }\`
- Comma-separated list of element ids to remove
- Also removes bound text elements (matching \`containerId\`)
- Place AFTER the elements you want to remove
- Never reuse a deleted id — always assign new ids to replacements

### Drawing Order (CRITICAL for streaming)
- Array order = z-order (first = back, last = front)
- **Emit progressively**: background → shape → its label → its arrows → next shape
- BAD: all rectangles → all texts → all arrows
- GOOD: bg_shape → shape1 → text1 → arrow1 → shape2 → text2 → ...

### Example: Two connected labeled boxes
\`\`\`json
[
  { "type": "cameraUpdate", "width": 800, "height": 600, "x": 50, "y": 50 },
  { "type": "rectangle", "id": "b1", "x": 100, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#a5d8ff", "fillStyle": "solid", "label": { "text": "Start", "fontSize": 20 } },
  { "type": "rectangle", "id": "b2", "x": 450, "y": 100, "width": 200, "height": 100, "roundness": { "type": 3 }, "backgroundColor": "#b2f2bb", "fillStyle": "solid", "label": { "text": "End", "fontSize": 20 } },
  { "type": "arrow", "id": "a1", "x": 300, "y": 150, "width": 150, "height": 0, "points": [[0,0],[150,0]], "endArrowhead": "arrow", "startBinding": { "elementId": "b1", "fixedPoint": [1, 0.5] }, "endBinding": { "elementId": "b2", "fixedPoint": [0, 0.5] } }
]
\`\`\`

### Camera & Sizing (CRITICAL for readability)

The diagram displays inline at ~700px width. Design for this constraint.

**Recommended camera sizes (4:3 aspect ratio ONLY):**
- Camera **S**: width 400, height 300 — close-up on a small group (2-3 elements)
- Camera **M**: width 600, height 450 — medium view, a section of a diagram
- Camera **L**: width 800, height 600 — standard full diagram (DEFAULT)
- Camera **XL**: width 1200, height 900 — large diagram overview. WARNING: font size smaller than 18 is unreadable
- Camera **XXL**: width 1600, height 1200 — panorama / final overview of complex diagrams. WARNING: minimum readable font size is 21

ALWAYS use one of these exact sizes. Non-4:3 viewports cause distortion.

**Font size rules:**
- Minimum fontSize: **16** for body text, labels, descriptions
- Minimum fontSize: **20** for titles and headings
- Minimum fontSize: **14** for secondary annotations only (sparingly)
- NEVER use fontSize below 14 — it becomes unreadable at display scale

**Element sizing rules:**
- Minimum shape size: 120×60 for labeled rectangles/ellipses
- Leave 20-30px gaps between elements minimum
- Prefer fewer, larger elements over many tiny ones

ALWAYS start with a \`cameraUpdate\` as the FIRST element. For example:
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\`

- x, y: top-left corner of visible area (scene coordinates)
- ALWAYS emit the cameraUpdate BEFORE drawing the elements it frames — camera moves first, then content appears
- The camera animates smoothly between positions
- Leave padding: don't match camera size to content size exactly (e.g., 500px content in 800x600 camera)

Examples:
\`{ "type": "cameraUpdate", "width": 800, "height": 600, "x": 0, "y": 0 }\` — standard view
\`{ "type": "cameraUpdate", "width": 400, "height": 300, "x": 200, "y": 100 }\` — zoom into a detail
\`{ "type": "cameraUpdate", "width": 1600, "height": 1200, "x": -50, "y": -50 }\` — panorama overview

Tip: For large diagrams, emit a cameraUpdate to focus on each section as you draw it.

## Tips
- Do NOT call read_me again — you already have everything you need
- Use the color palette consistently
- **Text contrast is CRITICAL** — never use light gray (#b0b0b0, #999) on white backgrounds. Minimum text color on white: #757575. For colored text on light fills, use dark variants (#15803d not #22c55e, #2563eb not #4a9eed). White text needs dark backgrounds (#9a5030 not #c4795b)
- Do NOT use emoji in text — they don't render in Excalidraw's font
- cameraUpdate is MAGICAL and users love it! please use it a lot to guide the user's attention as you draw. It makes a huge difference in readability and engagement.
`;

/**
 * Registers all Excalidraw tools and resources on the given McpServer.
 * Shared between local (main.ts) and Vercel (api/mcp.ts) entry points.
 */
export function registerTools(server: McpServer, distDir: string, store: CheckpointStore): void {
  const resourceUri = "ui://excalidraw/mcp-app.html";

  // ============================================================
  // Tool 1: read_me (call before drawing)
  // ============================================================
  server.registerTool(
    "read_me",
    {
      description: "Returns the Excalidraw element format reference with color palettes, examples, and tips. Call this BEFORE using create_view for the first time.",
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      return { content: [{ type: "text", text: RECALL_CHEAT_SHEET }] };
    },
  );

  // ============================================================
  // Tool 2: create_view (Excalidraw SVG)
  // ============================================================
  registerAppTool(server,
    "create_view",
    {
      title: "Draw Diagram",
      description: `Renders a hand-drawn diagram using Excalidraw elements.
Elements stream in one by one with draw-on animations.
Call read_me first to learn the element format.`,
      inputSchema: z.object({
        elements: z.string().describe(
          "JSON array string of Excalidraw elements. Must be valid JSON — no comments, no trailing commas. Keep compact. Call read_me first for format reference."
        ),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri } },
    },
    async ({ elements }): Promise<CallToolResult> => {
      if (elements.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Elements input exceeds ${MAX_INPUT_BYTES} byte limit. Reduce the number of elements or use checkpoints to build incrementally.` }],
          isError: true,
        };
      }
      let parsed: any[];
      try {
        parsed = JSON.parse(elements);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid JSON in elements: ${(e as Error).message}. Ensure no comments, no trailing commas, and proper quoting.` }],
          isError: true,
        };
      }

      // Resolve restoreCheckpoint references and save fully resolved state
      const restoreEl = parsed.find((el: any) => el.type === "restoreCheckpoint");
      let resolvedElements: any[];

      if (restoreEl?.id) {
        const base = await store.load(restoreEl.id);
        if (!base) {
          return {
            content: [{ type: "text", text: `Checkpoint "${restoreEl.id}" not found — it may have expired or never existed. Please recreate the diagram from scratch.` }],
            isError: true,
          };
        }

        const deleteIds = new Set<string>();
        for (const el of parsed) {
          if (el.type === "delete") {
            for (const id of String(el.ids ?? el.id).split(",")) deleteIds.add(id.trim());
          }
        }

        const baseFiltered = base.elements.filter((el: any) =>
          !deleteIds.has(el.id) && !deleteIds.has(el.containerId)
        );
        const newEls = parsed.filter((el: any) =>
          el.type !== "restoreCheckpoint" && el.type !== "delete"
        );
        resolvedElements = [...baseFiltered, ...newEls];
      } else {
        resolvedElements = parsed.filter((el: any) => el.type !== "delete");
      }

      // Check camera aspect ratios — nudge toward 4:3
      const cameras = parsed.filter((el: any) => el.type === "cameraUpdate");
      const badRatio = cameras.find((c: any) => {
        if (!c.width || !c.height) return false;
        const ratio = c.width / c.height;
        return Math.abs(ratio - 4 / 3) > 0.15;
      });
      const ratioHint = badRatio
        ? `\nTip: your cameraUpdate used ${badRatio.width}x${badRatio.height} — try to stick with 4:3 aspect ratio (e.g. 400x300, 800x600) in future.`
        : "";

      const checkpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
      await store.save(checkpointId, { elements: resolvedElements });
      return {
        content: [{ type: "text", text: `Diagram displayed! Checkpoint id: "${checkpointId}".
If user asks to create a new diagram - simply create a new one from scratch.
However, if the user wants to edit something on this diagram "${checkpointId}", take these steps:
1) read widget context (using read_widget_context tool) to check if user made any manual edits first
2) decide whether you want to make new diagram from scratch OR - use this one as starting checkpoint:
  simply start from the first element [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...your new elements...]
  this will use same diagram state as the user currently sees, including any manual edits they made in fullscreen, allowing you to add elements on top.
  To remove elements, use: {"type":"delete","ids":"<id1>,<id2>"}${ratioHint}` }],
        structuredContent: { checkpointId },
      };
    },
  );

  // ============================================================
  // Tool 3: export_to_excalidraw (server-side proxy for CORS)
  // Called by widget via app.callServerTool(), not by the model.
  // ============================================================
  registerAppTool(server,
    "export_to_excalidraw",
    {
      description: "Upload diagram to excalidraw.com and return shareable URL.",
      inputSchema: { json: z.string().describe("Serialized Excalidraw JSON") },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ json }): Promise<CallToolResult> => {
      if (json.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Export data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        // Parse and convert MCP format to native Excalidraw format
        const parsed = JSON.parse(json);
        const nativeElements = convertMcpToNative({ elements: parsed.elements || parsed });
        
        // Create proper Excalidraw JSON structure
        const excalidrawJson = JSON.stringify({
          type: "excalidraw",
          version: 2,
          source: "excalidraw-mcp",
          elements: nativeElements,
          appState: {
            viewBackgroundColor: "#ffffff",
            gridSize: null
          },
          files: {}
        });

        // --- Excalidraw v2 binary format ---
        const remappedJson = excalidrawJson;
        // concatBuffers: [version=1 (4B)] [len₁ (4B)] [data₁] [len₂ (4B)] [data₂] ...
        const concatBuffers = (...bufs: Uint8Array[]): Uint8Array => {
          let total = 4; // version header
          for (const b of bufs) total += 4 + b.length;
          const out = new Uint8Array(total);
          const dv = new DataView(out.buffer);
          dv.setUint32(0, 1); // CONCAT_BUFFERS_VERSION = 1
          let off = 4;
          for (const b of bufs) {
            dv.setUint32(off, b.length);
            off += 4;
            out.set(b, off);
            off += b.length;
          }
          return out;
        };
        const te = new TextEncoder();

        // 1. Inner payload: concatBuffers(fileMetadata, data)
        const fileMetadata = te.encode(JSON.stringify({}));
        const dataBytes = te.encode(remappedJson);
        const innerPayload = concatBuffers(fileMetadata, dataBytes);

        // 2. Compress inner payload with zlib deflate
        const compressed = deflateSync(Buffer.from(innerPayload));

        // 3. Generate AES-GCM 128-bit key + encrypt
        const cryptoKey = await globalThis.crypto.subtle.generateKey(
          { name: "AES-GCM", length: 128 },
          true,
          ["encrypt"],
        );
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          cryptoKey,
          compressed,
        );

        // 4. Encoding metadata (tells excalidraw.com how to decode)
        const encodingMeta = te.encode(JSON.stringify({
          version: 2,
          compression: "pako@1",
          encryption: "AES-GCM",
        }));

        // 5. Outer payload: concatBuffers(encodingMeta, iv, encryptedData)
        const payload = Buffer.from(concatBuffers(encodingMeta, iv, new Uint8Array(encrypted)));

        // 5. Upload to excalidraw backend
        const res = await fetch("https://json.excalidraw.com/api/v2/post/", {
          method: "POST",
          body: payload,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const { id } = (await res.json()) as { id: string };

        // 6. Export key as base64url string
        const jwk = await globalThis.crypto.subtle.exportKey("jwk", cryptoKey);
        const url = `https://excalidraw.com/#json=${id},${jwk.k}`;

        return { content: [{ type: "text", text: url }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Export failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  // Tool 4: export_to_png (export diagram as PNG base64)
  // ============================================================
  registerAppTool(server,
    "export_to_png",
    {
      description: "Export diagram as PNG image (base64 encoded). Converts MCP format to native Excalidraw format before export.",
      inputSchema: z.object({
        json: z.string().describe("Serialized Excalidraw JSON"),
        scale: z.number().optional().default(2).describe("Export scale (1, 2, or 3)")
      }),
      _meta: { ui: { visibility: ["app", "model"] } },
    },
    async ({ json, scale = 2 }): Promise<CallToolResult> => {
      if (json.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Export data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        // Parse and convert MCP format to native Excalidraw format
        const parsed = JSON.parse(json);
        const nativeElements = convertMcpToNative({ elements: parsed.elements || parsed });
        
        // Return the converted elements for client-side PNG export
        // The client will use exportToSvg and canvas to generate PNG
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              elements: nativeElements,
              scale: scale
            })
          }] 
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Export failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  // Tool 5: save_checkpoint (private — widget only, for user edits)
  // ============================================================
  registerAppTool(server,
    "save_checkpoint",
    {
      description: "Update checkpoint with user-edited state.",
      inputSchema: { id: z.string(), data: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id, data }): Promise<CallToolResult> => {
      if (data.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Checkpoint data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        await store.save(id, JSON.parse(data));
        return { content: [{ type: "text", text: "ok" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `save failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ============================================================
  // Tool 6: read_checkpoint (private — widget only)
  // ============================================================
  registerAppTool(server,
    "read_checkpoint",
    {
      description: "Read checkpoint state for restore.",
      inputSchema: { id: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id }): Promise<CallToolResult> => {
      try {
        const data = await store.load(id);
        if (!data) return { content: [{ type: "text", text: "" }] };
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `read failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // CSP: allow Excalidraw to load fonts from esm.sh
  const cspMeta = {
    ui: {
      csp: {
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://esm.sh"],
      },
    },
  };

  // Register the single shared resource for all UI tools
  registerAppResource(server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(distDir, "mcp-app.html"), "utf-8");
      return {
        contents: [{
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              ...cspMeta.ui,
              prefersBorder: true,
              permissions: { clipboardWrite: {} },
            },
          },
        }],
      };
    },
  );
}

/**
 * Creates a new MCP server instance with Excalidraw drawing tools.
 * Used by local entry point (main.ts) and Docker deployments.
 */
export function createServer(store: CheckpointStore): McpServer {
  const server = new McpServer({
    name: "Excalidraw",
    version: "1.0.0",
  });
  registerTools(server, DIST_DIR, store);
  return server;
}
