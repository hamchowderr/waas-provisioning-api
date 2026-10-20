// Serves the Agent Skills in mcp/skills over MCP, per the Skills extension (SEP-2640,
// io.modelcontextprotocol/skills): every file of a skill is a resource at
// skill://<name>/<file>, and skills/list and skills/get return each skill's frontmatter and the
// digest and size of each of its files. Skills ship with the package ("files" in package.json).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtocolError, ProtocolErrorCode, type McpServer } from '@modelcontextprotocol/server';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

export interface SkillFile {
  uri: string;
  mimeType: string;
  text: string;
  digest: string;
  size: number;
}

export interface Skill {
  /** skill://<name>/SKILL.md */
  uri: string;
  frontmatter: Record<string, unknown> & { name: string; description: string };
  files: SkillFile[];
}

const SKILLS_DIR = new URL('../skills/', import.meta.url);

const mimeTypeOf = (path: string) => (path.endsWith('.md') ? 'text/markdown' : path.endsWith('.json') ? 'application/json' : 'text/plain');

/** Every file under a directory, as paths relative to it with `/` separators. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, `${entry.parentPath}/${entry.name}`).split('\\').join('/'))
    .sort();
}

/** A SKILL.md's YAML frontmatter, as written. */
export function frontmatterOf(markdown: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) throw new Error('SKILL.md has no YAML frontmatter');
  const value = parseYaml(match[1]!) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SKILL.md frontmatter is not a mapping');
  return value as Record<string, unknown>;
}

let cached: Skill[] | undefined;

/** The skills this package ships, read once. */
export function loadSkills(): Skill[] {
  if (cached) return cached;
  const root = fileURLToPath(SKILLS_DIR);
  const skills: Skill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = `${root}${entry.name}`;
    const paths = filesUnder(dir);
    if (!paths.includes('SKILL.md')) continue;
    const files = paths.map((path): SkillFile => {
      const bytes = readFileSync(`${dir}/${path}`);
      return {
        uri: `skill://${entry.name}/${path}`,
        mimeType: mimeTypeOf(path),
        text: bytes.toString('utf8'),
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.length,
      };
    });
    const skillMd = files.find((file) => file.uri === `skill://${entry.name}/SKILL.md`)!;
    const frontmatter = frontmatterOf(skillMd.text);
    // The URI's last segment is the skill's name (SEP-2640, Resource Mapping).
    if (frontmatter.name !== entry.name || typeof frontmatter.description !== 'string') {
      throw new Error(`skills/${entry.name}/SKILL.md must have name: ${entry.name} and a description`);
    }
    skills.push({ uri: skillMd.uri, frontmatter: frontmatter as Skill['frontmatter'], files });
  }
  cached = skills;
  return skills;
}

/** A skills/list or skills/get entry. */
const entryOf = (skill: Skill) => ({
  uri: skill.uri,
  frontmatter: skill.frontmatter,
  resources: skill.files.map(({ uri, digest, size }) => ({ uri, digest, size })),
});

/**
 * Serves the skills on an MCP server: one resource per file, the extension in the server's
 * capabilities, and the skills/list and skills/get methods. Call before connecting.
 */
export function registerSkills(server: McpServer, skills: Skill[] = loadSkills()): void {
  for (const skill of skills) {
    for (const file of skill.files) {
      const isSkillMd = file.uri === skill.uri;
      const name = isSkillMd ? skill.frontmatter.name : file.uri.slice('skill://'.length);
      const metadata = isSkillMd ? { description: skill.frontmatter.description, mimeType: file.mimeType } : { mimeType: file.mimeType };
      server.registerResource(name, file.uri, metadata, async () => ({ contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] }));
    }
  }

  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION]: {} } });

  // Every skill fits on one page, so there is never a nextCursor.
  server.server.setRequestHandler('skills/list', { params: z.object({ cursor: z.string().optional() }).loose().optional() }, async () => ({
    skills: skills.map(entryOf),
  }));

  server.server.setRequestHandler('skills/get', { params: z.object({ uri: z.string() }).loose() }, async ({ uri }) => {
    const skill = skills.find((s) => s.uri === uri);
    if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill at ${uri}`);
    return { skill: entryOf(skill) };
  });
}
