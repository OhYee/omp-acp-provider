import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { __testing } from "../index";

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(resolve(tmpdir(), "omp-acp-runtime-models-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeSnapshot(directory: string, fileName: string, timestamp: number, models: unknown[]): void {
  writeFileSync(resolve(directory, fileName), JSON.stringify([{
    userId: "private-user-id",
    enterpriseId: "private-enterprise-id",
    data: { models },
    ts: timestamp,
  }]), "utf8");
}

describe("runtime ACP model metadata", () => {
  test("discovers hashed .info files and only projects model token limits", () => {
    withTemporaryDirectory(directory => {
      writeSnapshot(directory, "entry_7f3a.info", 10, [
        {
          id: "hy4free",
          name: "Hy4",
          maxInputTokens: 960_000,
          maxAllowedSize: 1_000_000,
          maxOutputTokens: 64_000,
          credits: "x0.00 credits",
          apiKey: "must-not-be-used",
          url: "https://must-not-be-used.invalid",
        },
        { id: "fallback-window", maxAllowedSize: 200_000, maxOutputTokens: 12_000 },
      ]);

      const models = __testing.readCodeBuddyRuntimeModels(directory);

      expect(models.get("hy4free")).toEqual({ contextWindow: 960_000, maxTokens: 64_000 });
      expect(models.get("fallback-window")).toEqual({ contextWindow: 200_000, maxTokens: 12_000 });
      expect(__testing.codeBuddyLocalStorageDirectory({ CODEBUDDY_CONFIG_DIR: directory })).toBe(resolve(directory, "local_storage"));
    });
  });

  test("uses the newest valid snapshot and ignores temporary or malformed files", () => {
    withTemporaryDirectory(directory => {
      writeSnapshot(directory, "entry_old.info", 10, [{ id: "hy4free", maxInputTokens: 512_000, maxOutputTokens: 32_000 }]);
      writeSnapshot(directory, "entry_new.info", 20, [{ id: "current-model", maxInputTokens: 256_000, maxOutputTokens: 16_000 }]);
      writeSnapshot(directory, "entry_uncommitted.info.tmp", 30, [{ id: "hy4free", maxInputTokens: 999_000, maxOutputTokens: 64_000 }]);
      writeFileSync(resolve(directory, "entry_broken.info"), "{not json", "utf8");

      const models = __testing.readCodeBuddyRuntimeModels(directory);

      expect(models.get("current-model")).toEqual({ contextWindow: 256_000, maxTokens: 16_000 });
      expect(models.has("hy4free")).toBe(false);
    });
  });

  test("returns an empty model map when the local cache is missing", () => {
    withTemporaryDirectory(directory => {
      expect(__testing.readCodeBuddyRuntimeModels(resolve(directory, "missing")).size).toBe(0);
    });
  });

  test("uses runtime limits for ACP model metadata without converting credits to USD", () => {
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
    const runtimeModels = new Map([[
      "hy4free",
      { contextWindow: 960_000, maxTokens: 64_000 },
    ]]);
    const metadata = __testing.getRuntimeModelMetadata(agent, "codebuddy/hy4free", runtimeModels);
    const model = __testing.agentModel(agent, "codebuddy/hy4free", "Hy4 (CodeBuddy)", false, undefined, undefined, metadata);

    expect(model).toMatchObject({
      contextWindow: 960_000,
      maxTokens: 64_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    const observedModel = __testing.agentModel(
      agent,
      "codebuddy/hy4free",
      "Hy4 (CodeBuddy)",
      false,
      undefined,
      1_000_000,
      metadata,
    );
    expect(observedModel.contextWindow).toBe(1_000_000);

    expect(__testing.getRuntimeModelMetadata(agent, "codebuddy/glm-5.3")).toBeUndefined();

  });

  test("uses OpenCode catalog limits and JSONC model overrides", () => {
    withTemporaryDirectory(directory => {
      const cacheFile = resolve(directory, "models.json");
      const configFile = resolve(directory, "opencode.jsonc");
      writeFileSync(cacheFile, JSON.stringify({
        openai: { models: {
          "gpt-base": {
            limit: { context: 200_000, output: 32_000 },
            cost: { input: 2, output: 8, cache_read: 0.2, cache_write: 1 },
          },
        } },
      }), "utf8");
      writeFileSync(configFile, `{
        // OpenCode accepts JSONC overrides.
        "providers": {
          "openai": {
            "models": {
              "gpt-base": { "limit": { "context": 256000, "output": 48000, }, },
              "gpt-alias": { "modelID": "gpt-base", "limit": { "output": 16000, }, },
            },
          },
        },
      }`, "utf8");

      const models = __testing.readOpenCodeRuntimeModels(cacheFile, [configFile], "");
      const agent = {
        id: "opencode",
        name: "OpenCode",
        command: "opencode",
        args: ["acp"],
        env: {},
        contextWindow: 128_000,
        maxTokens: 16_384,
        allowTools: false,
        modelOverrides: {},
      };
      const metadata = __testing.getRuntimeModelMetadata(agent, "openai/gpt-alias", models);
      const model = __testing.agentModel(agent, "opencode/openai/gpt-alias", "GPT alias", false, undefined, undefined, metadata);

      expect(models.get("openai/gpt-base")).toMatchObject({ contextWindow: 256_000, maxTokens: 48_000 });
      expect(model).toMatchObject({
        contextWindow: 256_000,
        maxTokens: 16_000,
        cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 1 },
      });
    });
  });

});
