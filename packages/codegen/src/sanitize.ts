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
