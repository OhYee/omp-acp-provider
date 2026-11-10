import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import type { ExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Model as OmpModel } from "@oh-my-pi/pi-ai";
import { __testing } from "../index";

describe("ACP provider-aware model metadata", () => {
  test("resolves provider-scoped model limits from the active ACP provider option", () => {
    const options: acp.SessionConfigOption[] = [{
      id: "provider",
      name: "Provider",
      type: "select",
      currentValue: "anthropic",
      options: [{ value: "anthropic", name: "Anthropic" }],
    }];
    const provider = __testing.currentModelProvider(options, "openrouter");
    const model = { id: "claude-sonnet-4-6" } as unknown as OmpModel;
    const resolvedCandidates: string[] = [];
    const models = {
      resolve(candidate: string) {
        resolvedCandidates.push(candidate);
        return candidate === "anthropic/claude-sonnet-4-6" ? model : undefined;
      },
    } as unknown as ExtensionModelQuery;
    const agent = {
      id: "cline",
      name: "Cline",
      command: "cline",
      args: [],
      env: {},
      contextWindow: 128_000,
      maxTokens: 16_384,
      allowTools: false,
      modelOverrides: {},
    };

    expect(provider).toBe("anthropic");
    expect(__testing.findCatalogModel(agent, "claude-sonnet-4-6", models, provider)).toBe(model);
    expect(resolvedCandidates).toEqual(["anthropic/claude-sonnet-4-6"]);
  });
  test("uses the pinned Cline provider when ACP hides its selector", () => {
    expect(__testing.currentModelProvider(undefined, "openrouter")).toBe("openrouter");
  });


  test("ignores a missing provider selection", () => {
    expect(__testing.currentModelProvider(undefined)).toBeUndefined();
  });
});
