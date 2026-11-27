# Model catalog

`node catalog/generate.ts` (`npm run generate-models`) fetches upstream catalogs and writes the built-in model catalog:

- `src/providers/data/<provider>.json`: model values, grouped by API (gitignored)
- `src/providers/<provider>.models.ts` and `src/models.generated.ts`: typed wrappers (committed)
- with `--json-output <dir>`: the public catalog JSON served by pi.dev

## Layout

| Path | Contents |
| --- | --- |
| `sources/` | Upstream fetchers. `models-dev.ts` normalizes the [models.dev v2](https://models.dev/experimental/v2.0/api.json) catalog; OpenRouter, Vercel AI Gateway, NVIDIA NIM, and Radius have their own modules. All sources are fetched before anything is built. |
| `providers/<id>.ts` | One file per built-in provider: where its models come from, its API and base URL, compat defaults, corrections, and models upstream does not list. Register new files in `providers/index.ts`. |
| `families/` | Facts about a model family that hold on every host, such as Claude effort levels or GPT-6 thinking levels. They apply to every provider's models. |
| `define.ts` | `defineProvider()` and the helpers provider files use. |
| `build.ts` | Runs the provider definitions in a fixed order. |

## Build order

For each provider:

1. `models(ctx)` returns its chat models: upstream entries mapped to pi models, data corrections (limits, prices), and authored models. `ctx.providerModels(id)` returns another provider's models from this step, e.g. Azure derives from OpenAI.
2. `compat` defaults for each API are merged under each model's own compat. Then the shared rules run: models.dev effort levels for APIs that send them natively, and the rules in `families/`.
3. `finalize(model, ctx)` applies provider-specific behavior. It runs after the shared rules, so its values win.
4. Image input limits get the default resize profile, then `finalizeAll(models, ctx)` runs cross-model logic such as Anthropic's allowed fallback models.

## Adding a provider

Most providers are a models.dev provider served on one API:

```ts
import { defineProvider, modelsDevModels } from "../define.ts";

export default defineProvider({
	id: "example",
	models: (ctx) =>
		modelsDevModels(ctx, "example", { api: "openai-completions", baseUrl: "https://api.example.com/v1" }),
	compat: { "openai-completions": { supportsStore: false } },
});
```

`modelsDevModels()` keeps tool-capable chat models and maps names, input modalities, costs (including context tiers), and limits. Use its `include` and `map` options for provider-specific filtering and fields. Prefer fixing wrong upstream data in models.dev; keep local corrections small and say why they exist.

## Released clients

pi.dev serves each published catalog to every released pi at or above `MINIMUM_PI_VERSION` (`scripts/model-catalog-minimum-version.mjs` in the repository root). Released clients use it within hours, without updating pi, and combine it with their own code's defaults, such as `detectCompat()` in `src/api/openai-completions.ts`.

A catalog change must therefore work with the latest release's code, not only with the code in the same commit. Example: a new code default makes `supportsDeveloperRole: false` redundant for a provider, so the line is removed from the catalog. Released clients still default to `true` and start sending the `developer` role, which the provider rejects.

If a catalog change needs new code, either keep the catalog working with old code (add explicit values; remove nothing old clients rely on), or set `MINIMUM_PI_VERSION` to the next release in the same commit. Clients below the minimum keep the last catalog published for them and receive no further catalog updates. `npm run check:model-catalog-compat` only catches type errors against the latest release, not changed behavior.

## Checking changes

`npm run diff:model-catalog -- [provider ...]` from the repository root generates the catalog at `HEAD` and in the worktree and prints the JSON differences.

The `CI` workflow builds and tests against the published revision in `nix/model-catalog.json` so live model additions and removals cannot change a rerun. To reproduce that build, run `node scripts/update-model-catalog-pin.mjs --hydrate` and then `npm run build:offline`. Live generation remains available through `npm run generate:models`.

Test catalog mapping changes with synthetic source data. If application code needs a new model ID, first land the catalog change without the application dependency so the Publish Model Catalog workflow can publish it. Then run `npm run update:model-catalog-pin` and include the updated pin with the application change after verifying it contains the required model. The automatic Nix pin refresh may keep the old revision when the provider, model type, and API groups are unchanged.

For a new provider, land its catalog definition and catalog registration first, without generated runtime wrappers or runtime registration. Once the catalog is published, land the refreshed pin with the generated wrappers and runtime registration, then verify the offline build. Pinned CI and preview packages do not verify the live catalog used by the tag-triggered npm publication build; that workflow runs its own build and checks.
