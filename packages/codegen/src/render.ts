import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Handlebars from 'handlebars';

import type { EntityFieldModel, EntityMethodModel, InterfaceMethodModel, Renderer } from './generate.js';

/**
 * Renderizador Handlebars para las plantillas de backend Spring (unidad 14b).
 *
 * Implementa la interfaz de 14a: `createHandlebarsRenderer()` compila cada plantilla
 * `.hbs` bajo `templates/spring-backend/` UNA SOLA VEZ y retorna un {@link Renderer}
 * que resuelve un id de plantilla a su plantilla compilada. Los scripts empaquetados del Maven
 * wrapper son recursos sin procesar (no hbs) servidos textualmente — son archivos de
 * terceros y nunca se compilan ni editan.
 *
 * Las plantillas son DATOS (propuesta: "las plantillas son datos, nunca código en tiempo de ejecución del
 * Sistema A"); este módulo es el único lugar que interactúa con el sistema de archivos para
 * renderizado, y lo hace solo en modo lectura al momento de construcción.
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Directorio de plantillas en la raíz del repositorio: packages/codegen/src → <root>/templates/spring-backend. */
export const DEFAULT_TEMPLATES_DIR = join(MODULE_DIR, '..', '..', '..', 'templates', 'spring-backend');

/** Lista blanca de recursos wrapper servibles sin procesar — protege contra salto de ruta vía modelo. */
const WRAPPER_ASSETS = new Set(['mvnw', 'mvnw.cmd', 'maven-wrapper.properties']);

/** Id de plantilla bajo el cual se emiten los recursos sin procesar de Maven wrapper. */
export const MAVEN_WRAPPER_TEMPLATE = 'maven-wrapper';

// ---------- helpers de nombres compartidos por las plantillas ----------

/** Convierte a minúscula el primer caracter (convención de propiedades Java bean). */
function camel(name: string): string {
  return name.length === 0 ? name : name[0].toLowerCase() + name.slice(1);
}

/** Convierte a mayúscula el primer caracter (sufijo getter/setter). */
function cap(name: string): string {
  return name.length === 0 ? name : name[0].toUpperCase() + name.slice(1);
}

/** camelCase / PascalCase → snake_case (para nombres de columnas FK / tabla de unión). */
function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Pluralización determinista simple en inglés usada para nombres de campos
 * de colecciones y segmentos de rutas REST (s / es / y→ies). Simplificación documentada;
 * 14c puede reemplazarlo con un mapeo basado en nombres de rol.
 */
function plural(word: string): string {
  if (word.length === 0) return word;
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Nombre de clase de entidad → segmento de ruta REST: ShippingAddress → shipping-addresses. */
function route(className: string): string {
  return snake(plural(camel(className)));
}

/** javaType → importaciones FQN requeridas por los tipos de campo declarados de la entidad. */
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
  hb.registerHelper('lower', (name: string) => String(name ?? '').toLowerCase());
  hb.registerHelper('snake', (name: string) => snake(String(name ?? '')));
  hb.registerHelper('plural', (name: string) => plural(String(name ?? '')));
  hb.registerHelper('route', (name: string) => route(String(name ?? '')));
  hb.registerHelper('typeImports', (fields: EntityFieldModel[] | undefined, methods: unknown) => {
    const imports = new Set<string>();
    for (const field of fields ?? []) {
      const fqcn = TYPE_IMPORTS[field.javaType];
      if (fqcn !== undefined) imports.add(fqcn);
    }
    const methodList: EntityMethodModel[] = Array.isArray(methods) ? methods : [];
    for (const method of methodList) {
      const fqcn = TYPE_IMPORTS[method.returnType];
      if (fqcn !== undefined) imports.add(fqcn);
      for (const param of method.parameters ?? []) {
        const paramFqcn = TYPE_IMPORTS[param.type];
        if (paramFqcn !== undefined) imports.add(paramFqcn);
      }
    }
    return [...imports].sort();
  });
  // 14c: importaciones java para firmas de métodos de interfaz (tipos de retorno + parámetros).
  hb.registerHelper('methodImports', (methods: InterfaceMethodModel[] | undefined) => {
    const imports = new Set<string>();
    for (const method of methods ?? []) {
      const fqcn = TYPE_IMPORTS[method.returnType];
      if (fqcn !== undefined) imports.add(fqcn);
      for (const param of method.parameters ?? []) {
        const paramFqcn = TYPE_IMPORTS[param.type];
        if (paramFqcn !== undefined) imports.add(paramFqcn);
      }
    }
    return [...imports].sort();
  });
}

/**
 * Construye un Renderer respaldado por las plantillas `.hbs` en `templatesDir`
 * (por defecto: raíz del repositorio `templates/spring-backend/`).
 *
 * @throws si el directorio de plantillas no existe o no contiene plantillas —
 *   falla de manera explícita en lugar de renderizar stubs silenciosamente.
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

  // Los recursos wrapper sin procesar se leen una vez y se cachean — textualmente, nunca con plantillas.
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
