/** Opt-in host Windows desktop control. Never merged with cloud Desktop. */
import { AITool } from "../ToolTypes";
import { hostAction, hostClick, hostMove, hostScroll, hostType, hostKey } from "../../desktop/hostDesktopActions";
export function makeHostDesktopStatusTool(tenantId: string): AITool {
    return {
        name: "host_desktop_status",
        description: "Status of opt-in host Windows desktop control. Separate from cloud Desktop and Browser.",
        parameters: { type: "object", properties: {} },
        defaultPermission: "allowed",
        execute: async () => hostAction(tenantId, { action: "status" }),
    };
}
export function makeHostDesktopScreenshotTool(tenantId: string): AITool {
    return {
        name: "host_desktop_screenshot",
        description: "Capture only the locally approved application window. Coordinates are relative to the returned image.",
        parameters: { type: "object", properties: {} },
        defaultPermission: "ask",
        execute: async () => {
            const result = await hostAction(tenantId, { action: "screenshot" });
            return { ok: result.ok, output: result.output, error: result.error, errorType: result.ok ? undefined : "PERMISSION_DENIED", meta: result.screenshot ? { screenshot: result.screenshot } : undefined };
        },
    };
}
export function makeHostDesktopMoveTool(tenantId: string): AITool {
    return {
        name: "host_desktop_move",
        description: "Move within the approved local window, using screenshot-relative coordinates. Requires local action approval.",
        parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
        defaultPermission: "ask",
        execute: async (args) => hostMove(tenantId, Number(args.x ?? 0), Number(args.y ?? 0)),
    };
}
export function makeHostDesktopClickTool(tenantId: string): AITool {
    return {
        name: "host_desktop_click",
        description: "Click within the approved local window, using screenshot-relative coordinates. Left button only. Requires local action approval.",
        parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left"] } }, required: ["x", "y"] },
        defaultPermission: "ask",
        execute: async (args) => hostClick(tenantId, Number(args.x ?? 0), Number(args.y ?? 0)),
    };
}
export function makeHostDesktopTypeTool(tenantId: string): AITool {
    return {
        name: "host_desktop_type",
        description: "Type into the focused host window. Requires Settings opt-in.",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        defaultPermission: "ask",
        execute: async (args) => hostType(tenantId, String(args.text ?? "")),
    };
}
export function makeHostDesktopScrollTool(tenantId: string): AITool {
    return {
        name: "host_desktop_scroll",
        description: "Scroll the host Windows desktop. Requires Settings opt-in.",
        parameters: { type: "object", properties: { delta: { type: "number" } } },
        defaultPermission: "ask",
        execute: async (args) => hostScroll(tenantId, Number(args.delta ?? -120)),
    };
}
export function makeHostDesktopFocusTool(tenantId: string): AITool {
    return {
        name: "host_desktop_focus",
        description: "Focus the locally approved window only; cannot select another application.",
        parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        defaultPermission: "ask",
        execute: async () => hostAction(tenantId, { action: "focus" }),
    };
}
export function makeHostDesktopKeyTool(tenantId: string): AITool {
    return { name: "host_desktop_key", description: "Press a single navigation key in the approved local window. System shortcuts are blocked; every input requires local approval.", parameters: { type: "object", properties: { key: { type: "string", enum: ["Enter", "Tab", "Escape", "Backspace", "Delete", "Left", "Right", "Up", "Down", "Home", "End", "PageUp", "PageDown"] } }, required: ["key"] }, defaultPermission: "ask", execute: args => hostKey(tenantId, String(args.key)) };
}
export function makeHostDesktopInspectTool(tenantId: string): AITool {
    return { name: "host_desktop_inspect", description: "Read accessibility controls of the locally approved window. Password fields are redacted.", parameters: { type: "object", properties: {} }, defaultPermission: "ask", execute: () => hostAction(tenantId, { action: "inspect" }) };
}
export function registerHostDesktopTools(register: (tool: AITool) => void, tenantId: string): void {
    register(makeHostDesktopInspectTool(tenantId));
    register(makeHostDesktopKeyTool(tenantId));
    register(makeHostDesktopStatusTool(tenantId));
    register(makeHostDesktopScreenshotTool(tenantId));
    register(makeHostDesktopMoveTool(tenantId));
    register(makeHostDesktopClickTool(tenantId));
    register(makeHostDesktopTypeTool(tenantId));
    register(makeHostDesktopScrollTool(tenantId));
    register(makeHostDesktopFocusTool(tenantId));
}
