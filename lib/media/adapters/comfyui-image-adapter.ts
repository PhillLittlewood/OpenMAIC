/**
 * ComfyUI Image Generation Adapter
 *
 * Submits a prompt to a local (or remote) ComfyUI instance via its
 * REST API, polls for completion, and returns the image as base64.
 *
 * Endpoint: http://localhost:8188  (configurable via baseUrl)
 * No API key required.
 *
 * Workflow loading strategy (browser-safe, no fs/path):
 *   1. If config.workflowJson is set (an already-parsed object), use it.
 *   2. Otherwise fetch /comfyui-workflow.json from Next.js public/ folder.
 *      → Place comfyui-workflow.json in your project's public/ directory.
 *
 * Nodes patched at runtime:
 *   "String (Multiline - Prompt)"  → inputs.value  = prompt
 *   "Empty Flux 2 Latent"          → inputs.width / height
 *   "KSampler"                     → inputs.seed   = random int
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { aspectRatioToDimensions, IMAGE_PROVIDERS } from '../image-providers';

// ---------------------------------------------------------------------------
// Logger  (matches openmaic's [TIMESTAMP] [LEVEL] [Component] format)
// ---------------------------------------------------------------------------

const COMPONENT = 'ComfyUI Image';

const log = {
  info:  (msg: string) => console.log( `[${new Date().toISOString()}] [INFO]  [${COMPONENT}] ${msg}`),
  warn:  (msg: string) => console.warn( `[${new Date().toISOString()}] [WARN]  [${COMPONENT}] ${msg}`),
  error: (msg: string) => console.error(`[${new Date().toISOString()}] [ERROR] [${COMPONENT}] ${msg}`),
  debug: (msg: string) => console.debug(`[${new Date().toISOString()}] [DEBUG] [${COMPONENT}] ${msg}`),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'http://localhost:8188';
/** Default public path for the workflow JSON (relative to Next.js public/) */
const DEFAULT_WORKFLOW_PUBLIC_PATH = '/comfyui-workflow.json';
/** Polling interval while waiting for the queue to finish (ms) */
const POLL_INTERVAL_MS = 1500;
/** Hard timeout for a single generation request (ms) */
const GENERATION_TIMEOUT_MS = 300_000; // 5 minutes
/** Fallback maxWidth if provider has no maxResolution defined */
const DEFAULT_MAX_WIDTH = 1024;

// ---------------------------------------------------------------------------
// Extended config type (avoids touching shared types.ts)
// ---------------------------------------------------------------------------

interface ComfyUIImageGenerationConfig extends ImageGenerationConfig {
  /**
   * Pre-parsed workflow object. When supplied the adapter skips the
   * fetch() call and uses this directly (deep-cloned on each request).
   */
  workflowJson?: Record<string, unknown>;
  /**
   * Public URL path to fetch the workflow JSON from.
   * Defaults to "/comfyui-workflow.json" (served from Next.js public/).
   */
  workflowPublicPath?: string;
}

// ---------------------------------------------------------------------------
// Workflow helpers
// ---------------------------------------------------------------------------

/**
 * Load and deep-clone the workflow.
 * - Browser: fetch() from the Next.js public/ origin
 * - Server (API route): read directly from disk with fs — relative URLs
 *   don't work in Node fetch since there's no browser origin to resolve against
 */
async function loadWorkflow(
  config: ComfyUIImageGenerationConfig,
): Promise<Record<string, unknown>> {
  // Fast path: caller already supplied the parsed JSON.
  if (config.workflowJson) {
    log.debug('Using pre-supplied workflowJson (skipping fetch)');
    return JSON.parse(JSON.stringify(config.workflowJson)) as Record<string, unknown>;
  }

  const publicPath = config.workflowPublicPath
    ?? (config.model ? `/${config.model}` : DEFAULT_WORKFLOW_PUBLIC_PATH);

  // Server-side: read from disk (public/ directory relative to cwd)
  if (typeof window === 'undefined') {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.join(process.cwd(), 'public', publicPath.replace(/^\//, ''));
    log.info(`Loading workflow from disk: "${filePath}"`);
    if (!fs.existsSync(filePath)) {
      log.error(`Workflow file not found at "${filePath}"`);
      throw new Error(
        `ComfyUI: workflow file not found at "${filePath}". ` +
          'Place comfyui-workflow.json in your Next.js public/ folder.',
      );
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    log.debug(`Workflow loaded from disk successfully`);
    return JSON.parse(raw) as Record<string, unknown>;
  }

  // Browser-side: fetch from origin
  const url = `${window.location.origin}${publicPath}`;
  log.info(`Loading workflow from "${url}"`);
  const response = await fetch(url);
  if (!response.ok) {
    log.error(`Failed to load workflow from "${url}" (HTTP ${response.status})`);
    throw new Error(
      `ComfyUI: could not load workflow from "${url}" (HTTP ${response.status}). ` +
        'Place comfyui-workflow.json in your Next.js public/ folder.',
    );
  }

  log.debug(`Workflow loaded from URL successfully`);
  return (await response.json()) as Record<string, unknown>;

  log.debug(`Workflow loaded successfully from "${url}"`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Walk every node in the workflow and return the id of the first node
 * whose _meta.title matches title (case-insensitive).
 */
function findNodeIdByTitle(
  workflow: Record<string, unknown>,
  title: string,
): string | undefined {
  const lower = title.toLowerCase();
  for (const [id, node] of Object.entries(workflow)) {
    const meta = (node as Record<string, unknown>)['_meta'] as
      | Record<string, unknown>
      | undefined;
    if (typeof meta?.title === 'string' && meta.title.toLowerCase() === lower) {
      return id;
    }
  }
  return undefined;
}

/**
 * Patch the workflow clone with the caller-supplied generation options.
 *
 * Prompt injection priority:
 *   1. Node titled "Input Prompt"  (preferred — explicit dedicated node)
 *   2. Node titled "String (Multiline - Prompt)"  (legacy fallback)
 *
 * Dimension injection priority:
 *   1. Nodes titled "Width" and "Height"  (preferred — explicit dedicated nodes)
 *   2. Node titled "Empty Flux 2 Latent"  (legacy fallback — patches inputs directly)
 */
function patchWorkflow(
  workflow: Record<string, unknown>,
  options: ImageGenerationOptions,
  maxWidth: number,
): void {

  // --- Resolve dimensions once -----------------------------------------------
  const dims = options.aspectRatio
    ? aspectRatioToDimensions(options.aspectRatio, maxWidth)
    : (options.width && options.height ? { width: options.width, height: options.height } : null);

  // --- Prompt node -----------------------------------------------------------
  // Try "Input Prompt" first, fall back to "String (Multiline - Prompt)"
  const promptNodeId =
    findNodeIdByTitle(workflow, 'Input Prompt') ??
    findNodeIdByTitle(workflow, 'String (Multiline - Prompt)');

  if (!promptNodeId) {
    log.error('No prompt node found — add a node titled "Input Prompt" to your workflow');
    throw new Error(
      'ComfyUI workflow is missing a prompt input node. ' +
        'Add a node titled "Input Prompt" (or "String (Multiline - Prompt)") to your workflow.',
    );
  }
  const promptNode = workflow[promptNodeId] as Record<string, Record<string, unknown>>;
  promptNode.inputs['value'] = options.prompt;
  log.debug(`Patched prompt node (id: ${promptNodeId}) → "${options.prompt.slice(0, 80)}${options.prompt.length > 80 ? '…' : ''}"`);

  // --- Width / Height nodes (preferred) -------------------------------------
  const widthNodeId  = findNodeIdByTitle(workflow, 'Width');
  const heightNodeId = findNodeIdByTitle(workflow, 'Height');

  if (widthNodeId && heightNodeId) {
    // Explicit Width / Height primitive nodes found — patch them
    if (dims) {
      const widthNode  = workflow[widthNodeId]  as Record<string, Record<string, unknown>>;
      const heightNode = workflow[heightNodeId] as Record<string, Record<string, unknown>>;
      widthNode.inputs['value']  = dims.width;
      heightNode.inputs['value'] = dims.height;
      log.debug(`Patched Width node (id: ${widthNodeId}) → ${dims.width}`);
      log.debug(`Patched Height node (id: ${heightNodeId}) → ${dims.height}`);
    } else {
      log.debug('Width/Height nodes found but no dimensions resolved — using workflow defaults');
    }
  } else {
    // Fall back to patching the latent size node directly
    if (widthNodeId || heightNodeId) {
      log.warn('Only one of "Width"/"Height" nodes found — both are needed. Falling back to latent node.');
    }
    const latentNodeId = findNodeIdByTitle(workflow, 'Empty Flux 2 Latent');
    if (latentNodeId) {
      const latentNode = workflow[latentNodeId] as Record<string, Record<string, unknown>>;
      if (dims) {
        latentNode.inputs['width']  = dims.width;
        latentNode.inputs['height'] = dims.height;
        log.debug(`Patched latent size node (id: ${latentNodeId}) → ${dims.width}×${dims.height} (aspectRatio: ${options.aspectRatio ?? 'none'})`);
      } else {
        log.debug(`Latent size node (id: ${latentNodeId}) — no dimensions resolved, using workflow defaults`);
      }
    } else {
      log.warn('No dimension nodes found ("Width"/"Height" or "Empty Flux 2 Latent") — using workflow defaults');
    }
  }

  // --- KSampler seed ---------------------------------------------------------
  const samplerNodeId = findNodeIdByTitle(workflow, 'KSampler');
  if (samplerNodeId) {
    const samplerNode = workflow[samplerNodeId] as Record<string, Record<string, unknown>>;
    const seed = Math.floor(Math.random() * 1e15);
    samplerNode.inputs['seed'] = seed;
    log.debug(`Patched KSampler seed (id: ${samplerNodeId}) → ${seed}`);
  } else {
    log.warn('KSampler node not found — seed not randomised');
  }
}

// ---------------------------------------------------------------------------
// ComfyUI REST helpers
// ---------------------------------------------------------------------------

interface QueuePromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

interface HistoryEntry {
  outputs: Record<
    string,
    {
      images?: Array<{ filename: string; subfolder: string; type: string }>;
    }
  >;
  status: { status_str: string; completed: boolean };
}

async function queuePrompt(
  baseUrl: string,
  workflow: Record<string, unknown>,
  clientId: string,
): Promise<string> {
  log.info(`Submitting workflow to queue [client_id: ${clientId}]`);
  const response = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error(`/prompt request failed (HTTP ${response.status}): ${text}`);
    throw new Error(`ComfyUI /prompt failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as QueuePromptResponse;

  if (data.node_errors && Object.keys(data.node_errors).length > 0) {
    log.error(`Node errors returned: ${JSON.stringify(data.node_errors)}`);
    throw new Error(
      `ComfyUI reported node errors: ${JSON.stringify(data.node_errors)}`,
    );
  }

  log.info(`Queued successfully — prompt_id: ${data.prompt_id} (queue position: ${data.number})`);
  return data.prompt_id;
}

async function pollHistory(
  baseUrl: string,
  promptId: string,
): Promise<HistoryEntry | null> {
  const response = await fetch(`${baseUrl}/history/${promptId}`);
  if (!response.ok) return null;
  const data = (await response.json()) as Record<string, HistoryEntry>;
  return data[promptId] ?? null;
}

async function fetchImageAsBase64(
  baseUrl: string,
  filename: string,
  subfolder: string,
  type: string,
): Promise<string> {
  const params = new URLSearchParams({ filename, subfolder, type });
  const response = await fetch(`${baseUrl}/view?${params.toString()}`);

  if (!response.ok) {
    throw new Error(
      `ComfyUI /view failed (${response.status}) for image "${filename}"`,
    );
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lightweight connectivity test — calls GET /system_stats.
 * Returns 200 when ComfyUI is running and reachable.
 */
export async function testComfyuiImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  log.info(`Testing connectivity to ${baseUrl}`);
  try {
    const response = await fetch(`${baseUrl}/system_stats`);
    if (response.ok) {
      log.info(`Connectivity test passed — ComfyUI is reachable at ${baseUrl}`);
      return { success: true, message: 'Connected to ComfyUI' };
    }
    log.warn(`Connectivity test failed — HTTP ${response.status} from ${baseUrl}`);
    return {
      success: false,
      message: `ComfyUI returned HTTP ${response.status}. Is it running at ${baseUrl}?`,
    };
  } catch (err) {
    log.error(`Connectivity test error: ${err}`);
    return {
      success: false,
      message: `ComfyUI connectivity error: ${err}. Is it running at ${baseUrl}?`,
    };
  }
}

export async function generateWithComfyuiImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const comfyConfig = config as ComfyUIImageGenerationConfig;

  log.info(`Starting image generation [baseUrl: ${baseUrl}] [model: ${config.model ?? 'default'}]`);
  log.info(`Prompt: "${options.prompt.slice(0, 120)}${options.prompt.length > 120 ? '…' : ''}"`);
  log.debug(`Options: ${JSON.stringify({ width: options.width, height: options.height, aspectRatio: options.aspectRatio })}`);

  const startTime = Date.now();

  // Resolve maxWidth from the provider's maxResolution (set in image-providers.ts)
  const maxWidth = IMAGE_PROVIDERS[config.providerId]?.maxResolution?.width ?? DEFAULT_MAX_WIDTH;

  // 1. Load and patch the workflow -------------------------------------------
  const workflow = await loadWorkflow(comfyConfig);
  patchWorkflow(workflow, options, maxWidth);

  // 2. Client ID for this request --------------------------------------------
  const clientId = `openmaic-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // 3. Submit to the queue ---------------------------------------------------
  const promptId = await queuePrompt(baseUrl, workflow, clientId);

  // 4. Poll history until complete -------------------------------------------
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  let entry: HistoryEntry | null = null;
  let pollCount = 0;

  log.info(`Polling for completion [prompt_id: ${promptId}]`);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    pollCount++;
    entry = await pollHistory(baseUrl, promptId);

    if (entry?.status?.completed) {
      log.info(`Generation complete after ${pollCount} poll(s) (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
      break;
    }

    if (pollCount % 10 === 0) {
      log.debug(`Still waiting… ${pollCount} polls, ${((Date.now() - startTime) / 1000).toFixed(0)}s elapsed`);
    }
  }

  if (!entry?.status?.completed) {
    log.error(`Generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s [prompt_id: ${promptId}]`);
    throw new Error(
      `ComfyUI generation timed out after ${GENERATION_TIMEOUT_MS / 1000}s ` +
        `(prompt_id: ${promptId})`,
    );
  }

  // 5. Extract the first output image ----------------------------------------
  let imageInfo: { filename: string; subfolder: string; type: string } | undefined;

  for (const nodeOutput of Object.values(entry.outputs)) {
    if (nodeOutput.images && nodeOutput.images.length > 0) {
      imageInfo = nodeOutput.images[0];
      break;
    }
  }

  if (!imageInfo) {
    log.error('Generation finished but no images found in output nodes');
    throw new Error(
      'ComfyUI finished but returned no images. ' +
        'Check that your workflow includes a SaveImage node.',
    );
  }

  log.info(`Fetching image "${imageInfo.filename}" from ComfyUI /view`);

  // 6. Download and encode the image -----------------------------------------
  const base64 = await fetchImageAsBase64(
    baseUrl,
    imageInfo.filename,
    imageInfo.subfolder,
    imageInfo.type,
  );

  const totalMs = Date.now() - startTime;
  const dims = options.aspectRatio
    ? aspectRatioToDimensions(options.aspectRatio, maxWidth)
    : (options.width && options.height ? { width: options.width, height: options.height } : null);

  log.info(`Image generation complete — ${imageInfo.filename} (${dims?.width ?? options.width ?? 1024}×${dims?.height ?? options.height ?? 1024}) in ${(totalMs / 1000).toFixed(1)}s`);

  return {
    base64,
    width:  dims?.width  ?? options.width  ?? 1024,
    height: dims?.height ?? options.height ?? 1024,
  };
}
