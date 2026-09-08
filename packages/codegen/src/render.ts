import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Handlebars from 'handlebars';

import type { EntityFieldModel, Renderer } from './generate.js';

/**
 * Handlebars renderer for the Spring backend templates (unit 14b).
 *
 * Implements the 14a seam: `createHandlebarsRenderer()` compiles every `.hbs`
 * template under `templates/spring-backend/` ONCE and returns a {@link Renderer}
 * that resolves a template id to its compiled template. The vendored Maven
 * wrapper scripts are raw (non-hbs) assets served verbatim — they are
 * third-party files and are never compiled or edited.
 *
 * Templates are DATA (proposal: "templates are data, never runtime code of
 * System A"); this module is the only place that touches the filesystem for
 * rendering, and it does so read-only at construction time.
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Repo-root template dir: packages/codegen/src → <root>/templates/spring-backend. */
export const DEFAULT_TEMPLATES_DIR = join(MODULE_DIR, '..', '..', '..', 'templates', 'spring-backend');

/** Whitelist of servable raw wrapper assets — guards against path traversal via model. */
const WRAPPER_ASSETS = new Set(['mvnw', 'mvnw.cmd', 'maven-wrapper.properties']);

/** Template id under which the raw Maven wrapper assets are emitted. */
export const MAVEN_WRAPPER_TEMPLATE = 'maven-wrapper';

// ---------- naming helpers shared by the templates ----------

/** Lowercase the first character (Java bean-property convention). */
function camel(name: string): string {
  return name.length === 0 ? name : name[0].toLowerCase() + name.slice(1);
}

/** Uppercase the first character (getter/setter suffix). */
function cap(name: string): string {
  return name.length === 0 ? name : name[0].toUpperCase() + name.slice(1);
}

/** camelCase / PascalCase → snake_case (for FK / join-table column names). */
function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Naive-but-deterministic English pluralization used for collection field
 * names and REST route segments (s / es / y→ies). Documented simplification;
 * 14c may replace it with a role-name-driven mapping.
 */
function plural(word: string): string {
  if (word.length === 0) return word;
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Entity class name → REST route segment: ShippingAddress → shipping-addresses. */
function route(className: string): string {
  return snake(plural(camel(className)));
}

/** javaType → FQN imports needed by an entity's declared field types. */
const TYPE_IMPORTS: Readonly<Record<string, string>> = {
  BigDecimal: 'java.math.BigDecimal',
  LocalDate: 'java.time.LocalDate',
  LocalDateTime: 'java.time.LocalDateTime',
  LocalTime: 'java.time.LocalTime',
};

function registerHelpers(hb: typeof Handlebars): void {
  hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  hb.registerHelper('lt', (a: unknown, b: unknown) => String(a) < String(b));
  hb.registerHelper('camel', (name: string) => camel(String(name ?? '')));
  hb.registerHelper('cap', (name: string) => cap(String(name ?? '')));
  hb.registerHelper('snake', (name: string) => snake(String(name ?? '')));
  hb.registerHelper('plural', (name: string) => plural(String(name ?? '')));
  hb.registerHelper('route', (name: string) => route(String(name ?? '')));
  hb.registerHelper('typeImports', (fields: EntityFieldModel[] | undefined) => {
    const imports = new Set<string>();
    for (const field of fields ?? []) {
      const fqcn = TYPE_IMPORTS[field.javaType];
      if (fqcn !== undefined) imports.add(fqcn);
    }
    return [...imports].sort();
  });
}

/**
 * Build a Renderer backed by the `.hbs` templates in `templatesDir`
 * (default: repo-root `templates/spring-backend/`).
 *
 * @throws if the templates directory is missing or contains no templates —
 *   fails loudly instead of silently rendering stubs.
 */
export function createHandlebarsRenderer(templatesDir: string = DEFAULT_TEMPLATES_DIR): Renderer {
  registerHelpers(Handlebars);

  const compiled = new Map<string, ReturnType<typeof Handlebars.compile>>();
  for (const entry of readdirSync(templatesDir)) {
    if (!entry.endsWith('.hbs')) continue;
    const source = readFileSync(join(templatesDir, entry), 'utf8');
    compiled.set(entry.slice(0, -'.hbs'.length), Handlebars.compile(source));
  }
  if (compiled.size === 0) {
    throw new Error(`no .hbs templates found in ${templatesDir}`);
  }

  // Raw wrapper assets are read once and cached — verbatim, never templated.
  const assetCache = new Map<string, string>();
  const rawAsset = (asset: string): string => {
    if (!WRAPPER_ASSETS.has(asset)) {
      throw new Error(`refusing to serve unknown maven-wrapper asset ${JSON.stringify(asset)}`);
    }
    let text = assetCache.get(asset);
    if (text === undefined) {
      text = readFileSync(join(templatesDir, 'maven-wrapper', asset), 'utf8');
      assetCache.set(asset, text);
    }
    return text;
  };

  return (template: string, model: unknown): string => {
    if (template === MAVEN_WRAPPER_TEMPLATE) {
      const asset = (model as { asset?: string } | null)?.asset ?? '';
      return rawAsset(asset);
    }
    const t = compiled.get(template);
    if (t === undefined) {
      throw new Error(`no template "${template}" in ${templatesDir}`);
    }
    return t(model);
  };
}
