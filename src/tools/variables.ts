import { z } from "zod";
import { requestVariables } from "../bridge/server";
import { bridge } from "../bridge/store";
import type { LocalStylesInfo, VariableCollectionInfo } from "../bridge/protocol";
import type { RgbaColor } from "../figma/types";
import { colorToHex, effectsToCss, paintToCss, paintsToFillStack, typeStyleToCss } from "../normalize/paint";
import { PlumbError } from "../errors";
import { fail, ok } from "./shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DESCRIPTION =
  "List the file's design-system names: every local Figma Variable collection " +
  "(modes, and each variable's value per mode — colours as hex, aliases as the " +
  "target variable's name, plus the Web code syntax when defined) and every " +
  "local named style (colour, text, effect) with its value. Use it to map the " +
  "hex values in plumb_node / plumb_tokens back to the names designers use. " +
  "Variables and styles from a team library are not listed here; they show by " +
  "name on the nodes that use them (`var`, `fillStyle`, `textStyle`, …). " +
  "Plugin path; needs the Plumb plugin paired.";

function isRgba(v: unknown): v is RgbaColor {
  return !!v && typeof v === "object" && "r" in v && "g" in v && "b" in v;
}

function formatValue(v: unknown): unknown {
  if (isRgba(v)) return colorToHex(v);
  if (v && typeof v === "object" && "alias" in v) return `→ ${(v as { alias: string }).alias}`;
  return v;
}

/** Raw plugin payload → the compact shape the agent reads. */
export function formatVariables(collections: VariableCollectionInfo[], styles: LocalStylesInfo) {
  return {
    collections: collections.map((c) => ({
      name: c.name,
      modes: c.modes,
      variables: c.variables.map((v) => {
        const values = Object.fromEntries(Object.entries(v.values).map(([m, x]) => [m, formatValue(x)]));
        // One mode is the common case — flatten to `value` to save tokens.
        const single = c.modes.length === 1 ? { value: Object.values(values)[0] } : { values };
        return {
          name: v.name,
          type: v.type,
          ...single,
          ...(v.web ? { web: v.web } : {}),
          ...(v.description ? { description: v.description } : {}),
        };
      }),
    })),
    styles: {
      color: styles.paint.map((s) => {
        const visible = s.paints.filter((p) => p.visible !== false);
        const solo = visible.length === 1 && visible[0]!.type === "SOLID";
        return {
          name: s.name,
          value: solo ? paintToCss(visible) : paintsToFillStack(s.paints),
          ...(s.description ? { description: s.description } : {}),
        };
      }),
      text: styles.text.map((s) => ({
        name: s.name,
        value: typeStyleToCss(s.style),
        ...(s.description ? { description: s.description } : {}),
      })),
      effect: styles.effect.map((s) => ({
        name: s.name,
        value: effectsToCss(s.effects) ?? s.effects.map((e) => e.type.toLowerCase()).join(", "),
        ...(s.description ? { description: s.description } : {}),
      })),
    },
  };
}

/** Registers the `plumb_variables` MCP tool. */
export function registerPlumbVariables(server: McpServer): void {
  server.registerTool(
    "plumb_variables",
    {
      title: "Plumb · variables & styles",
      description: DESCRIPTION,
      inputSchema: {
        collection: z
          .string()
          .optional()
          .describe("Only collections whose name contains this text (case-insensitive)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        if (!bridge.paired) {
          throw new PlumbError(
            "No Figma plugin is paired.",
            "plumb_variables uses the plugin path — run the Plumb plugin in Figma and click 'Pair with Plumb'.",
          );
        }
        const { collections, styles, error } = await requestVariables();
        if (error) {
          throw new PlumbError(
            `The plugin could not read variables and styles: ${error}`,
            "Retry; if it persists, re-run the Plumb plugin in Figma.",
          );
        }
        const filter = args.collection?.trim().toLowerCase();
        const picked = filter ? collections.filter((c) => c.name.toLowerCase().includes(filter)) : collections;
        const out = formatVariables(picked, styles);
        const variableCount = out.collections.reduce((n, c) => n + c.variables.length, 0);
        const styleCount = out.styles.color.length + out.styles.text.length + out.styles.effect.length;
        return ok({
          source: "plugin",
          variableCount,
          styleCount,
          ...out,
          next:
            variableCount + styleCount === 0
              ? "No local variables or styles. If nodes still show `var` / `fillStyle` names, they come from a team library."
              : "Match hex values from plumb_node / plumb_tokens to these names. Nodes carry the bound name directly in `var` / `fillStyle` / `textStyle`.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
