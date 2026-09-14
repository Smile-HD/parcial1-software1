/// Excepción explícita lanzada cuando no se puede alcanzar el backend.
/// Cumple con el requerimiento mobile:R2:
/// "DADO QUE el backend generado no se está ejecutando,
///  CUANDO el cliente intenta una solicitud,
///  ENTONCES el cliente muestra un error de conexión explícito,
///  Y NO DEBE mostrar datos obsoletos como si estuvieran en vivo."
class BackendConnectionException implements Exception {
  final String message;
  final dynamic cause;

  BackendConnectionException(this.message, [this.cause]);

  @override
  String toString() => 'BackendConnectionException: $message';
}

/// Lanzada cuando el backend retorna un error de cliente o servidor (ej. 400, 404, 500).
class BackendApiException implements Exception {
  final int statusCode;
  final String message;

  BackendApiException(this.statusCode, this.message);

  @override
  String toString() => 'BackendApiException ($statusCode): $message';
}
