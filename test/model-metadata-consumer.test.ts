import { describe, expect, test } from "bun:test";
import { __testing } from "../index";
import type { ExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Model as OmpModel } from "@oh-my-pi/pi-ai";

describe("runtime model metadata", () => {
  test("uses CodeBuddy runtime limits ahead of generic OMP catalog limits", () => {
    const agent = {
      id: "codebuddy",
      name: "CodeBuddy",
      command: "codebuddy",
      args: ["--acp"],
      env: {},
      contextWindow: 128_000,
      maxTokens: 16_384,
      allowTools: false,
      modelOverrides: {},
    };
    const catalogModel = {
      contextWindow: 128_000,
      maxTokens: 8_192,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    } as unknown as OmpModel;
    const runtimeModels = new Map([["glm-5.3", { contextWindow: 1_000_000, maxTokens: 48_000 }]]);
    const runtimeMetadata = __testing.getRuntimeModelMetadata(agent, "codebuddy/glm-5.3", runtimeModels);

    const model = __testing.agentModel(agent, "codebuddy/glm-5.3", "GLM-5.3", false, catalogModel, undefined, runtimeMetadata);

    expect(model).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 48_000,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });

  });
  test("resolves Copilot and Cursor model metadata through their OMP provider catalogs", () => {
    const catalogModel = { contextWindow: 256_000, maxTokens: 32_000 } as unknown as OmpModel;
    const agents = [
      { id: "copilot", name: "Copilot", command: "copilot", args: [], env: {}, contextWindow: 128_000, maxTokens: 16_384, allowTools: false, modelOverrides: {}, metadataProvider: "github-copilot" },
      { id: "cursor", name: "Cursor", command: "cursor-agent", args: [], env: {}, contextWindow: 128_000, maxTokens: 16_384, allowTools: false, modelOverrides: {}, metadataProvider: "cursor" },
    ];
    const models = {
      resolve: (id: string) => id === "github-copilot/example" || id === "cursor/example" ? catalogModel : undefined,
    } as unknown as ExtensionModelQuery;

    expect(__testing.findCatalogModel(agents[0]!, "example", models)).toBe(catalogModel);
    expect(__testing.findCatalogModel(agents[1]!, "example", models)).toBe(catalogModel);
  });
});
