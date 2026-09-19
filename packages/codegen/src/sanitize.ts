import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Sanitizador de nombres + guarda de contención en raíz de salida para codegen.
 *
 * Implementa la fila 1 de la Matriz de Amenazas de diseño ("Documentation-like paths"):
 * los nombres de clase/atributo están controlados por el usuario y alimentan tanto el
 * identificador Java generado como la ruta del archivo de salida, por lo que un nombre
 * como `../../pom.xml` no debe poder escapar de la raíz de salida del trabajo, y una palabra
 * reservada de Java como `class` no debe convertirse en un nombre de tipo generado.
 *
 * La política es RECHAZAR, no reescribir: un nombre fuera de la lista permitida lanza excepción
 * para que la generación falle de forma explícita en lugar de producir silenciosamente un identificador alterado.
 */
export class NameSanitizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NameSanitizerError';
  }
}

/**
 * Lista permitida de identificadores Java de la matriz de amenazas: `[A-Za-z_][A-Za-z0-9_]*`.
 * Deliberadamente estricta — sin puntos, barras, espacios o dígitos iniciales, de modo que el
 * salto de directorio (path traversal) y los nombres de archivos de compilación nunca coincidan.
 */
const JAVA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Palabras clave de Java + los literales boolean/null que son ilegales como identificadores
 * (JLS 3.9). `var`, `record`, `sealed`, etc., son contextuales, no reservados, por lo que
 * intencionalmente NO están listados.
 */
const JAVA_RESERVED = new Set<string>([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
]);

/** True cuando `name` es una palabra reservada o literal de Java (sensible a mayúsculas/minúsculas). */
export function isReservedJavaName(name: string): boolean {
  return JAVA_RESERVED.has(name);
}

/**
 * Valida `raw` como identificador de Java y lo retorna sin cambios.
 *
 * @throws {NameSanitizerError} si `raw` no coincide con `[A-Za-z_][A-Za-z0-9_]*` o es una
 *   palabra reservada. Esto es lo que rechaza `../../pom.xml` (formato inválido) y `class`
 *   (palabra reservada) de los casos ROJOS de la matriz de amenazas.
 */
export function sanitizeJavaName(raw: string): string {
  if (!JAVA_IDENTIFIER.test(raw)) {
    throw new NameSanitizerError(
      `Invalid Java name ${JSON.stringify(raw)}: must match [A-Za-z_][A-Za-z0-9_]*`,
    );
  }
  if (isReservedJavaName(raw)) {
    throw new NameSanitizerError(`Invalid Java name ${JSON.stringify(raw)}: reserved word`);
  }
  return raw;
}

/**
 * Normaliza cualquier cadena informal (ej. nombres con espacios, acentos, guiones o
 * palabras reservadas de Java) en un identificador Java válido y canónico.
 *
 * Reglas de normalización:
 * 1. Rechaza intentos de navegación por rutas ('..', '/', '\') o entradas vacías lanzando {@link NameSanitizerError}.
 * 2. Descompone y elimina acentos y diacríticos mediante Unicode NFD (ej. 'dirección' -> 'direccion', 'año' -> 'ano').
 * 3. Divide por caracteres no alfanuméricos y construye camelCase o PascalCase según `targetCase`.
 * 4. Si el resultado comienza con un dígito numérico (ej. '123code'), le antepone un guión bajo `_123code`.
 * 5. Si el resultado coincide con una palabra reservada de Java (ej. 'class' en camelCase), le antepone un guión bajo `_class`.
 * 6. Garantiza conformidad final con {@link sanitizeJavaName}.
 *
 * @param raw Nombre crudo proveniente del diagrama UML.
 * @param targetCase Formato deseado: 'camel' (atributos, métodos, parámetros) o 'pascal' (clases, interfaces).
 * @returns Identificador Java válido y sanitizado.
 */
export function normalizeJavaIdentifier(
  raw: string,
  targetCase: 'camel' | 'pascal' = 'camel',
): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new NameSanitizerError('Identifier cannot be empty');
  }

  // Prevenir inyección de rutas (path traversal)
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    throw new NameSanitizerError(
      `Path traversal sequence detected in identifier: ${JSON.stringify(raw)}`,
    );
  }

  // 1. Quitar acentos y diacríticos (ej. "dirección" -> "direccion", "año" -> "ano")
  const decomposed = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // 2. Extraer tokens alfanuméricos
  const tokens = decomposed
    .split(/[^A-Za-z0-9]+/)
    .filter((tok) => tok.length > 0);

  if (tokens.length === 0) {
    throw new NameSanitizerError(
      `Cannot derive a valid Java identifier from: ${JSON.stringify(raw)}`,
    );
  }

  // 3. Aplicar casing (camelCase o PascalCase)
  let result = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Si el token es todo mayúsculas y tiene longitud > 1 (ej. "USD", "ID"), se normaliza a minúsculas antes de capitalizar
    const isAllUpper = token.length > 1 && token === token.toUpperCase();
    const cleanToken = isAllUpper ? token.toLowerCase() : token;

    if (i === 0 && targetCase === 'camel') {
      result += cleanToken.charAt(0).toLowerCase() + cleanToken.slice(1);
    } else {
      result += cleanToken.charAt(0).toUpperCase() + cleanToken.slice(1);
    }
  }

  // 4. Si comienza con un dígito numérico, anteponer '_'
  if (/^[0-9]/.test(result)) {
    result = `_${result}`;
  }

  // 5. Si coincide con una palabra reservada de Java, anteponer '_'
  if (isReservedJavaName(result)) {
    result = `_${result}`;
  }

  // 6. Verificación final de contención/identificador
  return sanitizeJavaName(result);
}

/**
 * Resuelve `relPath` contra `outputRoot` y asegura que el resultado permanezca dentro de ella.
 *
 * Defensa en profundidad detrás de {@link sanitizeJavaName}: incluso si una ruta se construye
 * a partir de nombres, una ruta que intente escapar es rechazada antes de planificar cualquier escritura.
 *
 * @throws {NameSanitizerError} si la ruta resuelta no es igual a la raíz ni es
 *   descendiente de ella (ej. `../../pom.xml`, o una ruta absoluta en otro lugar).
 */
export function assertInsideOutputRoot(outputRoot: string, relPath: string): string {
  const root = resolve(outputRoot);
  const abs = isAbsolute(relPath) ? resolve(relPath) : resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new NameSanitizerError(
      `Refusing to write outside the job output root: ${JSON.stringify(relPath)}`,
    );
  }
  return abs;
}
