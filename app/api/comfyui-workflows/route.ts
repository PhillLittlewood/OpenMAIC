/**
 * GET /api/comfyui-workflows
 *
 * Returns a list of ComfyUI workflow JSON files found in the Next.js
 * public/ directory, with display names derived from their filenames.
 *
 * Filename → display name rules:
 *   - Strip leading "comfyui-" prefix (case-insensitive)
 *   - Strip .json extension
 *   - Replace hyphens and underscores with spaces
 *   - Title-case each word
 *
 * Examples:
 *   comfyui-anime-style.json   → { id: "comfyui-anime-style.json",   name: "Anime Style" }
 *   comfyui-line-art.json      → { id: "comfyui-line-art.json",      name: "Line Art" }
 *   my_portrait_workflow.json  → { id: "my_portrait_workflow.json",   name: "My Portrait Workflow" }
 *   comfyui-workflow.json      → { id: "comfyui-workflow.json",       name: "Workflow" }
 *
 * Response: { workflows: Array<{ id: string; name: string }> }
 */

import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

/** Convert a workflow filename to a human-readable display name */
function filenameToDisplayName(filename: string): string {
  return filename
    .replace(/\.json$/i, '')                    // strip extension
    .replace(/^comfyui[-_]?/i, '')              // strip leading "comfyui-" or "comfyui_"
    .replace(/[-_]+/g, ' ')                     // hyphens/underscores → spaces
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())   // title-case
    || 'Default Workflow';                       // fallback if name becomes empty
}

export async function GET() {
  try {
    const publicDir = path.join(process.cwd(), 'public');

    if (!fs.existsSync(publicDir)) {
      return NextResponse.json({ workflows: [] });
    }

    const files = fs.readdirSync(publicDir);

    const workflows = files
      .filter((f) => f.toLowerCase().endsWith('.json'))
      // Only include files that look like ComfyUI workflows —
      // must either start with "comfyui" or contain "workflow"
      .filter((f) => {
        const lower = f.toLowerCase();
        return lower.startsWith('comfyui') || lower.includes('workflow');
      })
      .map((filename) => ({
        id: filename,                           // used as config.model → workflow filename
        name: filenameToDisplayName(filename),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ workflows });
  } catch (err) {
    console.error('[ComfyUI Workflows API] Failed to list workflows:', err);
    return NextResponse.json({ workflows: [] });
  }
}
