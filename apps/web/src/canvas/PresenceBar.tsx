/**
 * PresenceBar — nombres de usuarios conectados mediante awareness de Yjs (realtime:R2, 6b.3).
 * Componente puramente presentacional para que la integración con awareness se mantenga testeable.
 *
 * unidad 13e.10 — el aria-label pasa por el diccionario i18n (reactivo).
 * unidad 13e.11 — chips claros estilo EA: avatar con iniciales + punto verde en línea +
 * nombre, dentro del contrato existente `presence-bar__user`.
 */
import { useT } from '../i18n';

/**
 * Iniciales para el avatar del chip: las primeras letras de los dos primeros
 * tokens alfanuméricos del nombre ("User-a1b2" → "UA", "Ana López" → "AL");
 * un nombre de un solo token aporta sus dos primeras letras.
 */
export function presenceInitials(name: string): string {
  const tokens = name.split(/[^a-zA-Z0-9À-ɏ]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return '';
  }
  if (tokens.length === 1) {
    return tokens[0]!.slice(0, 2).toUpperCase();
  }
  return (tokens[0]![0]! + tokens[1]![0]!).toUpperCase();
}

export function PresenceBar({ names }: { names: readonly string[] }) {
  const { t } = useT();
  if (names.length === 0) {
    return null;
  }
  return (
    <div className="presence-bar" aria-label={t('presence.onlineUsers')}>
      {names.map((name) => (
        <span key={name} className="presence-bar__user">
          {/* Chip estilo EA: avatar con iniciales + punto en línea + nombre completo. */}
          <span className="presence-bar__avatar" aria-hidden="true">
            {presenceInitials(name)}
          </span>
          <span className="presence-bar__dot" aria-hidden="true" />
          <span className="presence-bar__name">{name}</span>
        </span>
      ))}
    </div>
  );
}
