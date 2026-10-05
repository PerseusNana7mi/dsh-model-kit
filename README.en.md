# dsh-model-kit

English | [中文](README.md)

**Model metadata assistant for DeepSeek Harness:** review model capabilities and reference prices before saving them to DSH.

Designed for **DSH Desktop 0.2.x, starting with 0.2.0-rc.2**. The development and integration-test baseline is `0.2.0-rc.2`; other accepted host versions still need separate runtime verification. See the [compatibility policy](docs/development.md#宿主版本兼容策略).

<a href="assets/model-kit-ui.png"><img src="assets/model-kit-ui.png" alt="Model Kit settings page showing model capabilities and reference prices" width="600"></a>

## Features

| Feature | Description |
| --- | --- |
| Model metadata | Look up display names, context windows, output limits, input modalities, and recognized reasoning efforts from Models.dev. |
| Preview and compare | Fill a draft, review conflicting sources field by field, and undo the latest fill. |
| Pricing | Edit input, output, cache-read, and cache-write rates in native USD or CNY; use a reference rate and multiplier when appropriate. |
| Model import | Discover models through a provider already configured in DSH, preview them, and append selected models. |
| Built-in overrides | Override individual fields of inherited models or restore inheritance. |

Reference prices come from **Models.dev (USD)** or **basellm (native USD/CNY)**. Missing prices remain unknown, explicit zero remains zero, and the plugin does not convert currencies. See [recommendation rules](docs/pi-web-workflow.md) and [pricing sources](docs/pricing-sources.md).

## Install

The package is available as [`dsh-model-kit` on npm](https://www.npmjs.com/package/dsh-model-kit). Install it with the DSH CLI paired with Desktop:

```sh
dsh plugin --profile desktop add dsh-model-kit
```

For a separate Web profile, change `desktop` to `web`. Fully quit Desktop from the tray and reopen it. The assistant appears under **Settings → Model Kit** (shown as **模型信息助手** in Chinese). Running `npm install dsh-model-kit` alone does not mount the plugin in a DSH profile.

For an offline install, select a prebuilt `.tgz` in Desktop's plugin manager. To build a local package from source, use Node.js 22.19 or newer:

```sh
npm ci
npm pack
```

`npm pack` builds and creates a local archive; it does not publish to npm. Do not install unbuilt source as a plugin.

## Use

1. Configure a provider, protocol, API endpoint, and credentials in DSH's native model settings.
2. Open **Settings → Model Kit** and select a provider and model.
3. Choose **Fill model information**, review the draft, and compare sources when they disagree.
4. Optionally edit reference prices and their currency, source, or multiplier.
5. Save the reviewed changes. Model import and built-in overrides are available in the additional model actions.

Writes use DSH's Settings API and its revision check. If another operation changes the configuration first, reload and review the draft again. See the [editor guide](docs/editor.md) for details; the plugin UI and the detailed guide are currently in Chinese.

## Important limits

- Saving an explicit `maxTokens` also sets the default output limit for requests, not just a displayed capacity.
- Reasoning effort levels are only filled when recognized from an official model catalog. Merely knowing that a model can reason does not establish supported effort levels. Manually enabling reasoning defaults to `medium`, which is a plugin default rather than verified provider support.
- Saved prices are unit rates, not a bill. Session cost calculation and integration with DSH's native usage statistics are not implemented.
- Switching currency replaces that model's previously saved rates in the other currency. Complex or tiered prices are not converted into a fixed rate.

The plugin does not fetch catalogs or edit models automatically at startup. Catalog requests run through the host when needed; provider discovery uses DSH's configured credentials. API keys are not returned to the plugin's browser UI or sent to reference catalogs. Model fields and plugin prices are saved through Settings to the active profile's `cordis.patch.yml`.

## Documentation and license

- [Editor and troubleshooting](docs/editor.md)
- [Pricing and currency behavior](docs/pricing-sources.md)
- [Development and compatibility](docs/development.md)
- [Source references and third-party notices](docs/references.md)

MIT licensed. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). When reporting a problem, include the host and plugin versions, reproduction steps, and redacted errors, never API keys or a full profile configuration.
