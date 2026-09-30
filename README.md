# Nano Banana 2 Skill

AI image generation CLI powered by Gemini 3.1 Flash Image Preview (default) with support for Gemini 3 Pro and any Gemini model. Multi-resolution (512-4K), aspect ratios, cost tracking, broadcast-grade green screen transparency, reference images, and style transfer.

Also ships as a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill for AI-assisted image generation workflows.

## Install

**Requirements:** [Bun](https://bun.sh), [FFmpeg](https://ffmpeg.org) + [ImageMagick](https://imagemagick.org) (for transparent mode)

```bash
# Clone the repo
git clone https://github.com/kingbootoshi/nano-banana-2-skill.git ~/tools/nano-banana-2
cd ~/tools/nano-banana-2

# Install dependencies
bun install

# Link globally (no sudo needed - uses Bun's global bin)
bun link

# Set up your API key
mkdir -p ~/.nano-banana && chmod 700 ~/.nano-banana
echo "GEMINI_API_KEY=your_key_here" > ~/.nano-banana/.env
chmod 600 ~/.nano-banana/.env
```

Get a Gemini API key at [Google AI Studio](https://aistudio.google.com/apikey).

Now you can use `nano-banana` from anywhere.

### As a Claude Code Skill

When installed as a Claude Code skill, just say `/init` and Claude will clone the repo, install deps, and link the command for you. Then use it by saying "generate an image of..." and Claude handles the rest.

### Fallback (if `bun link` doesn't work)

```bash
mkdir -p ~/.local/bin
ln -sf ~/tools/nano-banana-2/src/cli.ts ~/.local/bin/nano-banana
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## Usage

```bash
# Basic - generates 1K image to current directory
nano-banana "minimal dashboard UI with dark theme"

# Custom output name
nano-banana "luxury product mockup" -o product

# Higher resolution
nano-banana "detailed landscape painting" -s 2K

# Ultra high res
nano-banana "cinematic widescreen scene" -s 4K -a 16:9

# Lower resolution (fast, cheap)
nano-banana "quick sketch concept" -s 512

# Custom output directory
nano-banana "UI screenshot" -o dashboard -d ~/Pictures
```

### Models

```bash
# Default - Nano Banana 2 (Gemini 3.1 Flash, fast and cheap)
nano-banana "your prompt"

# Pro - highest quality, 2x cost
nano-banana "your prompt" --model pro

# Any model ID
nano-banana "your prompt" --model gemini-2.5-flash-image
```

| Alias | Model | Best For |
|-------|-------|----------|
| `flash`, `nb2` | Gemini 3.1 Flash Image Preview | Speed, cost, high-volume |
| `pro`, `nb-pro` | Gemini 3 Pro Image Preview | Highest quality, complex composition |

### Aspect Ratios

```bash
# Widescreen
nano-banana "cinematic landscape" -a 16:9

# Portrait
nano-banana "mobile app screenshot" -a 9:16

# Ultra-wide
nano-banana "panoramic scene" -a 21:9

# Standard photo
nano-banana "product photo" -a 4:3
```

Supported: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `4:5`, `5:4`, `21:9`

### Reference Images

Edit, transform, or combine existing images:

```bash
# Edit an existing image
nano-banana "change the background to pure white" -r dark-ui.png -o light-ui

# Style transfer - multiple references
nano-banana "combine these two UI styles into one" -r style1.png -r style2.png -o combined

# Color correction
nano-banana "make this image more vibrant and increase contrast" -r photo.jpg
```

### Transparent Assets

Generate assets with transparent backgrounds using AI-powered background removal:

```bash
# Basic transparent asset
nano-banana "robot mascot character" -t -o mascot

# Logo with transparency
nano-banana "minimalist tech logo" -t -o logo

# Game asset
nano-banana "pixel art treasure chest" -t -o chest
```

The `-t` flag automatically prompts the AI to generate on a green screen, then uses FFmpeg `colorkey` + `despill` to key out the background and remove green spill from edge pixels. ImageMagick trims the result. Requires: `brew install ffmpeg imagemagick`

### Exact Dimensions

Control output dimensions by using a blank image as the last reference:

```bash
# First -r: your style reference
# Last -r: blank image in target dimensions
nano-banana "pixel art character, 256x256" -r style.png -r blank-256x256.png -o sprite
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output` | `nano-gen-{timestamp}` | Output filename (no extension) |
| `-s, --size` | `1K` | Image size: `512`, `1K`, `2K`, or `4K` |
| `-a, --aspect` | model default | Aspect ratio: `1:1`, `16:9`, `9:16`, etc. |
| `-m, --model` | `flash` | Model: `flash`/`nb2`, `pro`/`nb-pro`, or any model ID |
| `-d, --dir` | current directory | Output directory |
| `-r, --ref` | - | Reference image (can use multiple times) |
| `-t, --transparent` | - | Generate on green screen, remove background (FFmpeg) |
| `--api-key-stdin` | - | Read the Gemini API key from stdin (overrides env/file) |
| `--costs` | - | Show cost summary from generation history |
| `-h, --help` | - | Show help |

## Sizes and Costs

| Size | Resolution | Flash Cost | Pro Cost |
|------|-----------|------------|----------|
| `512` | ~512x512 | ~$0.045 | N/A (Flash only) |
| `1K` | ~1024x1024 | ~$0.067 | ~$0.134 |
| `2K` | ~2048x2048 | ~$0.101 | ~$0.134 |
| `4K` | ~4096x4096 | ~$0.151 | ~$0.24 |

## Cost Tracking

Every generation logs its cost to `~/.nano-banana/costs.json`. View your spending:

```bash
nano-banana --costs
```

Shows total generations, total spend, and per-model breakdown.

Estimates use paid-tier list prices and include text, thinking and tool-use tokens. Every request also runs Google Search grounding, which is counted at $14 per 1,000 queries even though the first 5,000 per month are free, so the estimate is an upper bound. Models without known pricing are logged as "not priced".

## Spending Guard

Before each request the CLI adds this month's logged spend to an estimate for the request (published per-image price) and refuses to run if the total would exceed the monthly budget. The default budget is $10. Change or disable it in `~/.nano-banana/config.json`:

```json
{ "monthlyBudget": 25 }
```

Set `"monthlyBudget": null` to disable the guard. Pass `--force` to skip it for a single request. If the config or cost log can't be read, the guard refuses to run rather than assume nothing was spent.

## API Key Configuration

The CLI resolves the Gemini API key in priority order:

1. `--api-key-stdin` (key piped in on stdin)
2. `GEMINI_API_KEY` environment variable
3. `.env` file in the current working directory
4. `.env` file in the repo root (next to `src/`)
5. `~/.nano-banana/.env`

Get a free key at [Google AI Studio](https://aistudio.google.com/apikey).

There is no `--api-key <key>` flag: a key passed as an argument ends up in shell history and is visible to other processes via `ps`.

```bash
# Option 1: Environment variable
export GEMINI_API_KEY=your_key_here

# Option 2: .env file in current directory
echo "GEMINI_API_KEY=your_key_here" > .env
chmod 600 .env

# Option 3: Global config
mkdir -p ~/.nano-banana && chmod 700 ~/.nano-banana
echo "GEMINI_API_KEY=your_key_here" > ~/.nano-banana/.env
chmod 600 ~/.nano-banana/.env

# Option 4: Pipe it in, e.g. from the macOS Keychain
security find-generic-password -s gemini -w | nano-banana "your prompt" --api-key-stdin
```

## How Transparent Mode Works

The `-t` flag uses a 3-step pipeline for pixel-perfect transparency:

1. **Green screen prompt** - The CLI automatically appends green screen instructions to your prompt, so the AI generates on a solid green background
2. **FFmpeg colorkey + despill** - `colorkey` removes the green background. `despill` reconstructs edge pixel colors by mathematically removing green contamination from the RGB channels - this is why edges are clean instead of having green fringe
3. **Auto-crop** - ImageMagick trims transparent padding and resets canvas

The key color is auto-detected from corner pixels (the AI generates near-green like `#05F904`, not exact `#00FF00`). Requires FFmpeg and ImageMagick: `brew install ffmpeg imagemagick`

## Use Cases

- **Landing page assets** - product mockups, UI previews
- **Image editing** - transform existing images with text prompts
- **Style transfer** - combine multiple reference images
- **Marketing materials** - hero images, feature illustrations
- **UI iterations** - quickly generate design variations
- **Transparent assets** - icons, logos, mascots with no background
- **Game assets** - sprites, tilesets, characters
- **Video production** - visual elements for Remotion/video compositions

## Claude Code Skill

When installed as a Claude Code plugin, the skill triggers on phrases like:
- "generate an image"
- "create a sprite"
- "make an asset"
- "generate artwork"

Claude will construct the appropriate `nano-banana` command based on your request, handling model selection, resolution, aspect ratio, reference images, transparency, and output configuration automatically.

## License

MIT
